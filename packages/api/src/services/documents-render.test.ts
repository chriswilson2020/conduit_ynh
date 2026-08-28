import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderPdf, RenderError, weasyprintAvailable } from "./documents-render.js";

/**
 * This file is in two halves, and the split is deliberate.
 *
 * The STUB half shadows `weasyprint` on PATH with a shell script that behaves the
 * way a real one would when it goes wrong, and it runs everywhere -- including on
 * a machine with no WeasyPrint installed, which is where the failure paths would
 * otherwise never be executed at all. Node resolves a bare command name against
 * `env.PATH` at spawn time, and renderPdf builds the child's env from
 * `process.env`, so prepending a directory here is enough to intercept it.
 *
 * The REAL half needs the binary and is gated on it, the same way the 36 MAIL_IT
 * tests are gated on their containers: a developer without WeasyPrint still gets a
 * green suite, and CI (which installs it) still proves the render path.
 */

const HAVE_WEASYPRINT = await weasyprintAvailable();
const itReal = HAVE_WEASYPRINT ? it : it.skip;

// ---------------------------------------------------------------- stub harness

let stubDir: string;
let markerPath: string;
const originalPath = process.env.PATH ?? "";

/** Write an executable `weasyprint` into a fresh directory and return that directory. */
function stub(body: string): string {
  const dir = mkdtempSync(join(stubDir, "bin-"));
  const file = join(dir, "weasyprint");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return dir;
}

/** Run `fn` with `dir` at the front of PATH, or as the whole of PATH when replacing. */
async function onPath<T>(dir: string, fn: () => Promise<T>, replace = false): Promise<T> {
  process.env.PATH = replace ? dir : `${dir}:${originalPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "conduit-render-"));
  markerPath = join(stubDir, "the-child-survived");
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

// ------------------------------------------------------------- failure paths

describe("renderPdf failure paths", () => {
  it("reports a non-zero exit and carries the child's stderr", async () => {
    const dir = stub("echo 'Fatal: no font found' >&2\nexit 3");
    const error = await onPath(dir, async () =>
      await renderPdf("<html></html>").catch((e: unknown) => e));

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("weasyprint exited 3");
    expect((error as RenderError).detail).toContain("Fatal: no font found");
  });

  it("survives a child that exits before reading a large stdin", async () => {
    // The write is still in flight when the pipe goes away, which is an EPIPE on
    // stdin. It must not surface as an unhandled 'error' event, and the rejection
    // must be the child's real reason rather than the broken pipe.
    const dir = stub("echo 'bad input' >&2\nexit 4");
    const big = `<html><body>${"x".repeat(2_000_000)}</body></html>`;
    const error = await onPath(dir, async () =>
      await renderPdf(big).catch((e: unknown) => e));

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("weasyprint exited 4");
    expect((error as RenderError).detail).toContain("bad input");
  });

  it("times out mid-chunk and kills the child rather than waiting for it", async () => {
    // Output has already started when the timer fires, which is the case that
    // distinguishes "settled" bookkeeping that works from bookkeeping that
    // double-settles or leaves the process running.
    const dir = stub(
      `printf '%s' '%PDF-1.7 partial'\nsleep 3\ntouch '${markerPath}'`,
    );
    const started = Date.now();
    const error = await onPath(dir, async () =>
      await renderPdf("<html></html>", { timeoutMs: 250 }).catch((e: unknown) => e));

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("render timed out");
    expect(Date.now() - started).toBeLessThan(2000);

    // The stub touches its marker only after a 3s sleep. Wait well past the
    // rejection but well short of that, and the file's absence is the evidence
    // that the child was actually killed and not merely abandoned.
    await new Promise((r) => setTimeout(r, 750));
    expect(existsSync(markerPath)).toBe(false);
  });

  it("stops a child that floods stdout past the size cap", async () => {
    const dir = stub("while true; do printf '%s' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; done");
    const error = await onPath(dir, async () =>
      await renderPdf("<html></html>", { maxBytes: 4096 }).catch((e: unknown) => e));

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("render exceeded the size cap");
  });

  it("rejects an exit-0 child that produced no PDF", async () => {
    // A zero-byte or non-PDF stdout on a successful exit would otherwise be
    // written to the files table as a document nobody can open.
    const dir = stub("exit 0");
    const error = await onPath(dir, async () =>
      await renderPdf("<html></html>").catch((e: unknown) => e));

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("weasyprint produced no PDF");
    expect((error as RenderError).detail).toContain("0 bytes");
  });

  it("rejects an exit-0 child whose stdout is not a PDF", async () => {
    const dir = stub("printf '%s' 'this is not a pdf at all'\nexit 0");
    const error = await onPath(dir, async () =>
      await renderPdf("<html></html>").catch((e: unknown) => e));

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("weasyprint produced no PDF");
  });

  it("reports a binary that is not there at all", async () => {
    const empty = mkdtempSync(join(stubDir, "empty-"));
    const error = await onPath(empty, async () =>
      await renderPdf("<html></html>").catch((e: unknown) => e), true);

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("could not start weasyprint");
  });

  it("returns what an exit-0 child wrote when it is a PDF", async () => {
    const dir = stub("printf '%s' '%PDF-1.7 stub'\nexit 0");
    const pdf = await onPath(dir, async () => await renderPdf("<html></html>"));

    expect(pdf.toString("ascii")).toBe("%PDF-1.7 stub");
  });
});

describe("weasyprintAvailable", () => {
  it("reports availability without throwing when the binary is absent", async () => {
    const empty = mkdtempSync(join(stubDir, "empty-avail-"));
    const present = await onPath(empty, async () => await weasyprintAvailable(), true);

    expect(present).toBe(false);
  });

  it("resolves to a boolean either way", async () => {
    await expect(weasyprintAvailable()).resolves.toBeTypeOf("boolean");
  });
});

// -------------------------------------------------------- the real binary

/** A 1x1 PNG, scaled by CSS. Stands in for the org profile's logo. */
const LOGO_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4" +
  "2mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** As close to a real one-page quote as this task can get before Task 4 exists. */
function quoteHtml(): string {
  const rows = Array.from({ length: 8 }, (_, i) =>
    `<tr><td>Consultancy, phase ${String(i + 1)}</td><td class="n">2.000</td>` +
    `<td class="n">1,250.00</td><td class="n">21%</td><td class="n">2,500.00</td></tr>`,
  ).join("");
  return `<html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 18mm 16mm 22mm 16mm; @bottom-center { content: "Page " counter(page); } }
body { font-family: sans-serif; font-size: 10pt; color: #111; }
header { display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 8mm; }
img.logo { width: 40mm; height: 12mm; }
table { width: 100%; border-collapse: collapse; margin-top: 10mm; }
th, td { border-bottom: 1px solid #ccc; padding: 2mm 1mm; text-align: left; }
td.n, th.n { text-align: right; }
tfoot td { font-weight: bold; border-top: 2px solid #333; }
</style></head><body>
<header><div><img class="logo" src="${LOGO_PNG}" alt=""><p>Listerdale Life Sciences</p></div>
<div><h1>QUOTE QUO-2026-0001</h1><p>Issued 2026-08-28<br>Valid until 2026-09-27</p></div></header>
<p>Acme Manufacturing BV<br>Keizersgracht 1<br>1015 CJ Amsterdam</p>
<table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit</th>
<th class="n">Tax</th><th class="n">Total</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="4">Total incl. tax</td><td class="n">24,200.00</td></tr></tfoot></table>
<h2>Terms</h2><p>Payment within 30 days of invoice. Prices exclude travel.</p>
</body></html>`;
}

describe("renderPdf against the real binary", () => {
  itReal("returns a PDF for ordinary HTML", async () => {
    const pdf = await renderPdf("<html><body><h1>Quote</h1></body></html>");
    // %PDF- is the format's magic number; every conforming file starts with it.
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(500);
  });

  itReal("renders a realistic one-page quote, and reports what it cost", async () => {
    const started = Date.now();
    const pdf = await renderPdf(quoteHtml());
    const elapsed = Date.now() - started;

    // Printed because DEFAULT_TIMEOUT_MS and DEFAULT_MAX_BYTES in
    // documents-render.ts claim to be calibrated against a real page: this line
    // in the CI log is that measurement.
    console.log(`[render] one-page quote: ${String(pdf.length)} bytes in ${String(elapsed)} ms`);

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    // A tenth of the 25MB cap and half the 20s timeout: bounds that fail if a
    // realistic page ever stops being comfortably inside either default.
    expect(pdf.length).toBeLessThan(2.5 * 1024 * 1024);
    expect(elapsed).toBeLessThan(10_000);
  });

  itReal("rejects HTML that would take longer than the timeout", async () => {
    await expect(renderPdf(quoteHtml(), { timeoutMs: 1 }))
      .rejects.toBeInstanceOf(RenderError);
  });

  itReal("rejects a real render that exceeds the size cap", async () => {
    await expect(renderPdf(quoteHtml(), { maxBytes: 200 }))
      .rejects.toBeInstanceOf(RenderError);
  });
});

// ------------------------------------------------------------- the network

/**
 * The no-network property, proved in both directions against a loopback server
 * that records what asked it for anything.
 */
describe("renderPdf and the network", () => {
  let server: Server;
  let hits: string[] = [];
  let origin = "";

  beforeAll(async () => {
    hits = [];
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from(LOGO_PNG.split(",")[1] ?? "", "base64"));
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    origin = typeof address === "object" && address !== null
      ? `http://127.0.0.1:${String(address.port)}`
      : "";
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });

  const remoteHtml = (): string =>
    `<html><head><link rel="stylesheet" href="${origin}/remote.css"></head>` +
    `<body><img src="${origin}/remote.png" alt=""></body></html>`;

  itReal("a bare weasyprint DOES fetch an absolute URL with no base URL set", async () => {
    // The characterisation half. Omitting --base-url only leaves RELATIVE
    // references unresolvable; this is the evidence that it does nothing about
    // absolute ones, and therefore that NO_NETWORK_ENV is load-bearing rather
    // than decorative.
    hits.length = 0;
    const env = { ...process.env };
    for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]) {
      delete env[key];
    }
    await new Promise<void>((resolve) => {
      const child = spawn("weasyprint", ["-", "-"], { stdio: ["pipe", "ignore", "ignore"], env });
      child.on("close", () => { resolve(); });
      child.on("error", () => { resolve(); });
      child.stdin.on("error", () => { /* the child may not read it all */ });
      child.stdin.end(remoteHtml(), "utf8");
    });

    expect(hits.length).toBeGreaterThan(0);
  });

  itReal("renderPdf fetches nothing, and still produces a PDF", async () => {
    hits.length = 0;
    const pdf = await renderPdf(remoteHtml());

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(hits).toEqual([]);
  });
});
