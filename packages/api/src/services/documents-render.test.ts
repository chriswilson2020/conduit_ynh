import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderPdf, RenderError, weasyprintAvailable } from "./documents-render.js";

/**
 * This file is in two halves, and the split is deliberate.
 *
 * The STUB half shadows `python3` on PATH with a shell script that behaves the way a
 * real renderer would when it goes wrong, and it runs everywhere -- including on a
 * machine with no WeasyPrint, which is where the failure paths would otherwise never
 * be executed at all. Node resolves a bare command name against `env.PATH` at spawn
 * time and renderPdf builds the child's env from `process.env`, so prepending a
 * directory here is enough to intercept it. Nine tests below do that.
 *
 * The REAL half needs WeasyPrint and is gated on it, so a developer without it still
 * gets a green suite. That gate is NOT the MAIL_IT pattern, which is an explicit
 * opt-in: this one probes, so it would skip silently if a packaging change ever
 * stopped delivering the binary. "is installed here" below is what makes that loud
 * in CI instead.
 */

const HAVE_WEASYPRINT = await weasyprintAvailable();
const itReal = HAVE_WEASYPRINT ? it : it.skip;

// ---------------------------------------------------------------- stub harness

let stubDir: string;
let markerPath: string;
const originalPath = process.env.PATH ?? "";

/** Write an executable `python3` into a fresh directory and return that directory. */
function stub(body: string): string {
  const dir = mkdtempSync(join(stubDir, "bin-"));
  const file = join(dir, "python3");
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
    expect((error as RenderError).message).toBe("renderer exited 3");
    expect((error as RenderError).detail).toContain("Fatal: no font found");
  });

  it("survives a child that exits before reading a large stdin", async () => {
    // The write is still in flight when the pipe goes away, which is an EPIPE on
    // stdin. It must not surface as an unhandled 'error' event, and the rejection
    // must be the child's real reason rather than the broken pipe. 500KB is well
    // past the 64KB pipe buffer and well inside the input cap.
    const dir = stub("echo 'bad input' >&2\nexit 4");
    const big = `<html><body>${"x".repeat(500_000)}</body></html>`;
    const error = await onPath(dir, async () =>
      await renderPdf(big).catch((e: unknown) => e));

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("renderer exited 4");
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
    expect((error as RenderError).message).toBe("renderer produced no PDF");
    expect((error as RenderError).detail).toContain("0 bytes");
  });

  it("rejects an exit-0 child whose stdout is not a PDF", async () => {
    const dir = stub("printf '%s' 'this is not a pdf at all'\nexit 0");
    const error = await onPath(dir, async () =>
      await renderPdf("<html></html>").catch((e: unknown) => e));

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("renderer produced no PDF");
  });

  it("reports an interpreter that is not there at all", async () => {
    const empty = mkdtempSync(join(stubDir, "empty-"));
    const error = await onPath(empty, async () =>
      await renderPdf("<html></html>").catch((e: unknown) => e), true);

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("could not start the renderer");
  });

  it("returns what an exit-0 child wrote when it is a PDF", async () => {
    const dir = stub("printf '%s' '%PDF-1.7 stub'\nexit 0");
    const pdf = await onPath(dir, async () => await renderPdf("<html></html>"));

    expect(pdf.toString("ascii")).toBe("%PDF-1.7 stub");
  });

  it("refuses oversized input without spawning anything", async () => {
    // Rejected before the spawn, so it holds even where no renderer exists --
    // note there is no stub on PATH for this one.
    const error = await renderPdf("x".repeat(4096), { maxInputBytes: 1024 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("document is too large to render");
    expect((error as RenderError).detail).toContain("4096 bytes of HTML");
  });
});

describe("weasyprintAvailable", () => {
  it("reports availability without throwing when there is no interpreter", async () => {
    const empty = mkdtempSync(join(stubDir, "empty-avail-"));
    const present = await onPath(empty, async () => await weasyprintAvailable(), true);

    expect(present).toBe(false);
  });

  it("resolves to a boolean either way", async () => {
    await expect(weasyprintAvailable()).resolves.toBeTypeOf("boolean");
  });

  // The other half of an auto-probing gate. Without this, apt failing to deliver
  // WeasyPrint would turn the whole real half below into silent skips and CI would
  // stay green through a broken deployment.
  it.runIf(Boolean(process.env.CI))("is installed here, because CI must prove the render", () => {
    expect(HAVE_WEASYPRINT).toBe(true);
  });
});

// -------------------------------------------------------- the real renderer

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

describe("renderPdf against the real renderer", () => {
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

    // Printed because the caps in documents-render.ts claim to be calibrated
    // against a real page: this line in the log is that measurement. The byte
    // count is version-dependent (14,005 on 57.2, 12,457 on 61.1) and varies by
    // a byte between runs, so nothing asserts an exact size.
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

// ------------------------------------------------------------- the schemes

/** Search a PDF for a marker, including inside its Flate-compressed streams. */
function pdfContains(pdf: Buffer, marker: string): boolean {
  if (pdf.includes(marker)) return true;
  let from = 0;
  for (;;) {
    const start = pdf.indexOf("stream", from);
    if (start === -1) return false;
    const end = pdf.indexOf("endstream", start);
    if (end === -1) return false;
    let body = start + "stream".length;
    if (pdf[body] === 0x0d) body += 1;
    if (pdf[body] === 0x0a) body += 1;
    try {
      if (inflateSync(pdf.subarray(body, end)).includes(marker)) return true;
    } catch {
      // Not a Flate stream, or not a stream at all. Keep looking.
    }
    // Past the whole "endstream" keyword, not one byte into it: resuming at end+1
    // makes the next search match the "stream" inside it, whose paired "endstream"
    // is the FOLLOWING object's -- which silently skips every other stream.
    from = end + "endstream".length;
  }
}

/**
 * The no-network claim, tested as what it actually is: a claim about SCHEMES.
 *
 * An earlier version of this suite tested http://127.0.0.1 alone and generalised to
 * "fetches nothing", which is how a working file:// exfiltration survived it. Every
 * scheme below is therefore its own case, and the http one still watches a loopback
 * server so that "no request arrived" is observed rather than inferred.
 */
describe("renderPdf and the schemes it will fetch", () => {
  let server: Server;
  const hits: string[] = [];
  let origin = "";
  let secretPath = "";
  let secretCssPath = "";
  const SECRET = "conduit-secret-marker-9f3a";

  beforeAll(async () => {
    secretPath = join(stubDir, "pretend-mail.key");
    writeFileSync(secretPath, `${SECRET}\n`, { mode: 0o600 });
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
    // A local stylesheet that reaches back out over http. Whether it was READ is
    // then observable as a request, without depending on anything reaching the PDF:
    // a hit on /from-local-css.png can only happen if the file:// CSS was fetched
    // AND parsed. That makes "the file was never opened" a positive observation.
    secretCssPath = join(stubDir, "probe.css");
    writeFileSync(secretCssPath, `body { background-image: url("${origin}/from-local-css.png"); }\n`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });

  const blocked = (): { name: string; html: () => string }[] => [
    {
      name: "file:// as an image",
      html: () => `<html><body><img src="file://${secretPath}"></body></html>`,
    },
    {
      name: "file:// as a stylesheet that would phone home if it were read",
      html: () => `<html><head><link rel="stylesheet" href="file://${secretCssPath}"></head><body>x</body></html>`,
    },
    {
      name: "http:// as an image",
      html: () => `<html><body><img src="${origin}/probe.png"></body></html>`,
    },
    {
      name: "ftp://, a scheme urllib supports and nothing here wants",
      html: () => `<html><body><img src="ftp://127.0.0.1/x.png"></body></html>`,
    },
    {
      name: "jar:file://, the exotic one",
      html: () => `<html><body><img src="jar:file://${secretPath}!/x"></body></html>`,
    },
  ];

  for (const scheme of blocked()) {
    itReal(`refuses to render a document referencing ${scheme.name}`, async () => {
      hits.length = 0;
      const error = await renderPdf(scheme.html()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).message).toBe("document referenced a blocked URL");
      // No PDF is produced at all, so there is nothing for a caller to store -- and
      // for the stylesheet case, no hit here also proves the file was never opened.
      expect(hits).toEqual([]);
    });
  }

  itReal("never lets a file:// attachment reach the PDF, on either version", async () => {
    // THE ONE VERSION-CONDITIONAL CASE, and it is asserted as the property rather
    // than the mechanism because the two versions differ.
    //
    // On the server's 57.2 this is the exfiltration that forced this whole module to
    // stop using the CLI: WeasyPrint fetches the target and writes it into the PDF's
    // /EmbeddedFiles, so the fetcher sees it and the render is refused. On CI's 61.1
    // the fetcher is never called for this element at all and the render simply
    // succeeds with nothing embedded. Why 61.1 differs is not established here; only
    // that it does. Either way the file must not come out the other side, so that is
    // what is asserted.
    hits.length = 0;
    const result = await renderPdf(
      `<html><body><link rel="attachment" href="file://${secretPath}"></body></html>`,
    ).catch((e: unknown) => e);

    if (result instanceof RenderError) {
      expect(result.message).toBe("document referenced a blocked URL");
    } else {
      const pdf = result as Buffer;
      expect(pdf.includes("/EmbeddedFiles")).toBe(false);
      expect(pdfContains(pdf, SECRET)).toBe(false);
    }
    expect(hits).toEqual([]);
  });

  itReal("renders a data: image, which is the one scheme a document may use", async () => {
    const pdf = await renderPdf(`<html><body><img src="${LOGO_PNG}"></body></html>`);

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  itReal("renders without a relative reference rather than failing on it", async () => {
    // base_url is None, so a relative URL resolves to nothing and the fetcher is
    // never reached. This is the one case that degrades quietly, and it is the
    // harmless one: nothing was read and nothing was fetched.
    hits.length = 0;
    const pdf = await renderPdf(`<html><body><img src="../../etc/passwd"></body></html>`);

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(hits).toEqual([]);
  });

  // ---- the other direction: what the bare CLI does, and why it is not used ----

  /** Feed HTML to the `weasyprint` CLI with a plain environment. Returns its stdout. */
  async function bareCli(html: string): Promise<Buffer> {
    const env = { ...process.env };
    for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ftp_proxy"]) {
      delete env[key];
    }
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      const child = spawn("weasyprint", ["-", "-"], {
        stdio: ["pipe", "pipe", "ignore"],
        env,
      });
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.on("error", () => { resolve(); });
      child.on("close", () => { resolve(); });
      child.stdin.on("error", () => { /* the child may not read it all */ });
      child.stdin.end(html, "utf8");
    });
    return Buffer.concat(chunks);
  }

  itReal("a bare CLI fetches an absolute http:// URL with no base URL set", async () => {
    // Omitting --base-url leaves only RELATIVE references unresolvable. This is the
    // evidence for that, and for why the proxy variables were ever added.
    hits.length = 0;
    await bareCli(`<html><body><img src="${origin}/probe.png"></body></html>`);

    expect(hits).toContain("/probe.png");
  });

  itReal("a bare CLI reads local files, which no proxy setting can prevent", async () => {
    // The finding that broke the previous design, stated so it holds on any version:
    // the CLI opens a file:// stylesheet, and the request the CSS then makes is the
    // proof it was read and parsed. file:// goes to urllib's FileHandler and never
    // consults a proxy, so this is exactly what the environment variables cannot
    // reach -- and it is why the renderer is invoked through its API with a fetcher.
    hits.length = 0;
    await bareCli(
      `<html><head><link rel="stylesheet" href="file://${secretCssPath}"></head><body>x</body></html>`,
    );

    expect(hits).toContain("/from-local-css.png");
  });
});
