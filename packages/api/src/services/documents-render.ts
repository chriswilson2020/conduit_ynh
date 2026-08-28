import { spawn } from "node:child_process";

/** A render that failed for any reason: spawn, timeout, non-zero exit, or size cap. */
export class RenderError extends Error {
  constructor(message: string, readonly detail: string = "") {
    super(message);
    this.name = "RenderError";
  }
}

export interface RenderOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * 20s. Measured against the binary CI installs: a one-page quote with a logo, a
 * table of line items and a page-level stylesheet renders in well under a second
 * (documents-render.test.ts asserts the shape of that page, and the CI job's
 * timing is the evidence for this number). The cap is therefore not a budget for
 * the normal case; it is the ceiling on a pathological one, and it also bounds
 * how long the issuing transaction holds its row lock on the number sequence.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 25MB. A one-page quote is a few tens of kilobytes plus whatever the logo weighs,
 * so this is three orders of magnitude of headroom rather than a tuned limit. It
 * exists to stop an unbounded stream being accumulated in memory, not to reject
 * large-but-legitimate documents.
 */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** Enough stderr to diagnose a failure, bounded so a chatty child cannot balloon it. */
const STDERR_CAP_BYTES = 8 * 1024;

/** Every conforming PDF starts with this. An exit-0 render that does not is not one. */
const PDF_MAGIC = "%PDF-";

/**
 * The child's environment, and the mechanism that makes rendering touch no network.
 *
 * `--base-url` being absent is NOT that mechanism, which is the trap this constant
 * exists to avoid. A base URL is only what RELATIVE references resolve against;
 * an absolute `http://...` in the document needs nothing to resolve against and is
 * fetched regardless. WeasyPrint's fetcher is urllib, and `urlopen` builds its
 * opener with a `ProxyHandler` that reads exactly these variables, so pointing them
 * at a closed loopback port makes every http(s) fetch fail at connect instead of
 * reaching the network. A document that slipped a remote URL past the sanitiser
 * therefore renders without that asset rather than fetching it -- which is the
 * belt to the sanitiser's braces, and what removes SSRF from a feature whose input
 * is user-authored HTML.
 *
 * Port 9 is the discard service, which nothing on this host listens on; a connect
 * to a closed loopback port is refused immediately rather than hanging, so the
 * failure costs the render no time.
 *
 * documents-render.test.ts proves this in both directions: that a bare `weasyprint`
 * DOES fetch an absolute URL with no base URL set, and that `renderPdf` does not.
 */
const NO_NETWORK_ENV = {
  http_proxy: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ftp_proxy: "http://127.0.0.1:9",
  no_proxy: "",
  NO_PROXY: "",
} as const;

/**
 * WeasyPrint reads HTML from stdin and writes PDF to stdout when both paths are "-".
 *
 * Rejects with a RenderError for every failure, and never resolves with anything
 * that is not a PDF: a child that exits 0 having written nothing (or having written
 * something else) is a failed render, not an empty document.
 */
export async function renderPdf(html: string, options: RenderOptions = {}): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("weasyprint", ["-", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...NO_NETWORK_ENV },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let errSize = 0;
    let settled = false;

    const detail = (): string => Buffer.concat(err).toString("utf8").slice(0, 2000);

    // clearTimeout here rather than only in `close`: `close` fires once the child's
    // stdio is fully closed, and the whole point of the timeout is the case where
    // that may not happen promptly. Clearing it at the moment we settle means the
    // timer can never outlive the promise it was guarding.
    const fail = (message: string, extra = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new RenderError(message, extra));
    };

    const timer = setTimeout(() => { fail("render timed out", detail()); }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail("render exceeded the size cap", `stopped after ${String(size)} bytes`);
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errSize >= STDERR_CAP_BYTES) return;
      errSize += chunk.length;
      err.push(chunk);
    });
    child.on("error", (e) => { fail("could not start weasyprint", e.message); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new RenderError(`weasyprint exited ${String(code)}`, detail()));
        return;
      }
      const pdf = Buffer.concat(out);
      if (pdf.subarray(0, PDF_MAGIC.length).toString("ascii") !== PDF_MAGIC) {
        reject(new RenderError(
          "weasyprint produced no PDF",
          `${String(pdf.length)} bytes on stdout; ${detail()}`,
        ));
        return;
      }
      resolve(pdf);
    });

    // Registered before the write, because a child that fails fast closes its stdin
    // while this write is still in flight and the EPIPE that follows must not be an
    // unhandled 'error' event. `close` reports the real reason.
    child.stdin.on("error", () => { /* see above */ });
    child.stdin.end(html, "utf8");
  });
}

/** Whether the binary is present. Never throws -- the tests gate on it. */
export async function weasyprintAvailable(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("weasyprint", ["--version"], { stdio: "ignore" });
    child.on("error", () => { resolve(false); });
    child.on("close", (code) => { resolve(code === 0); });
  });
}
