import { spawn } from "node:child_process";
import { inflateSync } from "node:zlib";

/** A render that failed for any reason: spawn, timeout, non-zero exit, or a cap. */
export class RenderError extends Error {
  constructor(message: string, readonly detail: string = "") {
    super(message);
    this.name = "RenderError";
  }
}

export interface RenderOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxInputBytes?: number;
}

/**
 * 20s. About 30x a one-page quote, measured on the server's WeasyPrint 57.2 against
 * the exact document documents-render.test.ts renders. See DEFAULT_MAX_INPUT_BYTES
 * for the measurements across the whole range this is allowed to see; the timeout is
 * NOT what bounds a render's cost, and treating it as though it were is the mistake
 * that produced the first version of these numbers.
 *
 * It also bounds how long the issuing transaction holds its row lock on the number
 * sequence, which is why it is not larger still.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 25MB of OUTPUT. Three orders of magnitude above a real quote: this exists to stop
 * an unbounded stream being accumulated in memory, not to reject a large but
 * legitimate document.
 */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * 128KB of INPUT. **This, not the timeout, is what bounds a render's cost.**
 *
 * Measured on the server (Debian 12, WeasyPrint 57.2) against TABLE-shaped documents,
 * because that is the shape a quote is and it is far more expensive than prose --
 * varied prose at a given size, and a run of one repeated character even more so,
 * both lay out much more cheaply and would have set this cap far too high:
 *
 *   input     time     peak RSS
 *   2.4 KB    0.6 s     67 MB     (the one-page quote the tests render, 16,776 out)
 *   32 KB     1.6 s     87 MB
 *   64 KB     2.8 s    110 MB
 *   128 KB    5.2 s    157 MB     <- the cap
 *   256 KB    9.8 s    251 MB
 *   1 MB     39.7 s    816 MB
 *   2 MB     86.5 s   1565 MB
 *
 * For contrast, 2MB of PROSE is 15.9s and 245MB: at equal size the shape decides, by
 * a factor of six. Single runs on an otherwise idle server; the times move a few per
 * cent between runs and the RSS figures barely at all.
 *
 * **The timeout cannot bound memory, because the expensive documents are the ones
 * fast enough to survive it.** At a 2MB cap, 256KB of table finishes in 10s -- well
 * inside the 20s ceiling -- and costs 251MB; three concurrently is 753MB on a 3819MB
 * server with no swap, where that is a kill rather than a slowdown. Only a size cap
 * catches the ones that succeed.
 *
 * 128KB holds a render to ~157MB, so three concurrent renders are ~471MB, which is
 * the budget manifest.toml declares and the concurrency limit Task 4 must enforce.
 * A one-page quote is 2.4KB, so this is ~50x a real document -- and the headroom is
 * for the org profile's logo, which arrives inlined as a `data:` URI at 4/3 of its
 * stored size. **A logo above ~64KB would not fit, so Task 5's upload has to bound
 * it.** The failure would otherwise be a quote that cannot be raised at all.
 */
const DEFAULT_MAX_INPUT_BYTES = 128 * 1024;

/** Enough stderr to diagnose a failure, bounded so a chatty child cannot balloon it. */
const STDERR_CAP_BYTES = 8 * 1024;

/** Every conforming PDF starts with this. An exit-0 render that does not is not one. */
const PDF_MAGIC = "%PDF-";

/** The renderer refused a non-`data:` URL. */
const EXIT_BLOCKED_URL = 2;
/** The renderer refused a `rel=attachment`, which never reaches the URL fetcher. */
const EXIT_BLOCKED_ATTACHMENT = 3;

/**
 * The renderer, and the reason this module spawns Python rather than the `weasyprint`
 * CLI. It has three controls, because one was not enough and two were not either.
 *
 * The threat is a local file read, not just SSRF. `default_url_fetcher` hands every
 * absolute URI to `urllib.urlopen`, whose opener carries `FileHandler` alongside the
 * HTTP ones, and WeasyPrint writes `rel=attachment` targets into the PDF. Shown on
 * the server against this module's earlier CLI invocation:
 * `<link rel="attachment" href="file:///etc/passwd">` exited 0 and the file came back
 * out of the PDF byte for byte. On a deployment the interesting file is
 * $DATA_DIR/mail.key -- readable by the `conduit` user the API runs as, and with it
 * every stored IMAP and SMTP password.
 *
 * 1. A `url_fetcher` allowlisting `data:`. The CLI has no flag for this; the API does,
 *    and it replaces the default outright. Covers images, stylesheets, fonts,
 *    `@import`, `url()`, SVG and `xlink:href`, on both versions.
 *
 * 2. `rel=attachment` refused outright, because control 1 does NOT reach attachments.
 *    Established by a CI run, not assumed: on 61.1 `Attachment.__init__` binds
 *    `url_fetcher=default_url_fetcher` as a DEFAULT ARGUMENT, so the one passed to
 *    `HTML(...)` never arrives and the file was read with the fetcher recording no
 *    calls at all. Checked on the parsed tree rather than the source text, and it
 *    covers `<a rel=attachment>` as well as `<link>`.
 *
 * 3. `pdfEmbedsFiles` below, on the bytes that come back. See its own comment for why
 *    the needle is not the obvious one.
 *
 * A blocked resource FAILS the render rather than degrading quietly. By the time HTML
 * reaches this module, documents-template.ts has stripped every non-`data:` URL, so
 * one arriving here means either an attack or a hole in that sanitiser -- the moment
 * to fail, spend no document number, and leave a line in the log, rather than hand
 * back a plausible-looking quote.
 *
 * The two failures have distinct exit codes rather than a shared marker string in
 * stderr, so the message this module reports is decided by the child's status and not
 * by matching text that several different causes could emit.
 *
 * Kept inline rather than in a checked-in .py: with control 3 moved into TypeScript
 * there is no longer any part of this script that a unit test would want to reach
 * directly, and inlining leaves no second artifact for the release tarball to omit
 * and no runtime path to resolve.
 */
const RENDER_SCRIPT = `
import sys

import weasyprint
from weasyprint.urls import default_url_fetcher

blocked_urls = []
blocked_attachments = []


def fetcher(url, timeout=10, ssl_context=None):
    if url.startswith('data:'):
        return default_url_fetcher(url, timeout, ssl_context)
    blocked_urls.append(url[:120])
    raise ValueError('conduit: blocked non-data URL')


document = weasyprint.HTML(
    string=sys.stdin.buffer.read().decode('utf-8'),
    base_url=None,
    url_fetcher=fetcher,
)

for element in document.etree_element.iter():
    rel = element.get('rel')
    if rel and 'attachment' in rel.lower().split():
        blocked_attachments.append(str(element.tag))

if blocked_attachments:
    sys.stderr.write(
        'conduit-blocked-attachment: ' + ' | '.join(blocked_attachments) + '\\n')
    sys.exit(3)

document.write_pdf(sys.stdout.buffer)

if blocked_urls:
    sys.stderr.write('conduit-blocked-url: ' + ' | '.join(blocked_urls) + '\\n')
    sys.exit(2)
`;

/**
 * A cheap second barrier, and NOT the one that matters -- recorded plainly because an
 * earlier version of this file claimed it was, and because an assertion that trusted
 * it turned out to prove nothing.
 *
 * WeasyPrint's fetcher is urllib, and `urlopen` builds its opener with a
 * `ProxyHandler` that reads exactly these variables, so pointing them at a closed
 * loopback port makes an http(s) fetch fail at connect. What that does NOT cover is
 * every other scheme: `file://` goes to `FileHandler` and never consults a proxy at
 * all, which is how the exfiltration above worked underneath these very settings.
 *
 * It also means a test cannot use "did my loopback server get a request" to prove
 * anything about the fetcher, because this stops the request before it could arrive.
 * The suite reads atime instead, which sees an open by any code path.
 *
 * Lowercase `http_proxy` is the one that counts (`getproxies_environment` ignores the
 * uppercase form when REQUEST_METHOD is set, per CVE-2016-1000110); the uppercase pair
 * is here for anything else in the child that reads them. `no_proxy` is emptied to
 * override an inherited `no_proxy=*`, not because empty differs from absent.
 *
 * Port 9 is the discard service, which nothing here listens on; a connect to a closed
 * loopback port is refused immediately rather than hanging.
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
 * Whether a PDF carries an embedded file, by either route WeasyPrint uses.
 *
 * **The needle is deliberately not `/EmbeddedFiles`,** which is what an earlier
 * version looked for and which catches only half of it. `<link rel=attachment>`
 * registers in the catalog's `/EmbeddedFiles` name tree; `<a rel=attachment>` embeds
 * through an ANNOTATION file-spec that never appears there. Measured on both 57.2 and
 * 61.1: the `<a>` form produces a PDF containing the file with no `/EmbeddedFiles`
 * anywhere in it. `/EF` and `/Filespec` are present for both routes and absent from a
 * branded quote with or without a `data:` logo, so those are the needles.
 *
 * Names can live inside compressed object streams -- 61.1 compresses by default,
 * which is why a raw byte search once made an embedded file look absent -- so this
 * inflates what it can before deciding.
 *
 * This is the only control that is a statement about the OUTPUT rather than about a
 * mechanism, which is the point of it: it is what would still hold if a future
 * WeasyPrint grew a third route to the filesystem.
 */
export function pdfEmbedsFiles(pdf: Buffer): boolean {
  const needles = ["/EF", "/Filespec"];
  const hit = (haystack: Buffer): boolean => needles.some((n) => haystack.includes(n));
  if (hit(pdf)) return true;

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
      if (hit(inflateSync(pdf.subarray(body, end)))) return true;
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
 * Render HTML to a PDF, reading nothing but the string it is given.
 *
 * Rejects with a RenderError for every failure, and never resolves with anything that
 * is not a PDF: a child that exits 0 having written nothing (or something else) is a
 * failed render, not an empty document.
 */
export async function renderPdf(html: string, options: RenderOptions = {}): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;

  const inputBytes = Buffer.byteLength(html, "utf8");
  if (inputBytes > maxInputBytes) {
    throw new RenderError(
      "document is too large to render",
      `${String(inputBytes)} bytes of HTML, limit ${String(maxInputBytes)}`,
    );
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("python3", ["-c", RENDER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...NO_NETWORK_ENV },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let errSize = 0;
    let settled = false;

    const detail = (): string =>
      Buffer.concat(err).toString("utf8").slice(0, STDERR_CAP_BYTES);

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
    child.on("error", (e) => { fail("could not start the renderer", e.message); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === EXIT_BLOCKED_URL || code === EXIT_BLOCKED_ATTACHMENT) {
        reject(new RenderError("document referenced a blocked resource", detail()));
        return;
      }
      if (code !== 0) {
        reject(new RenderError(`renderer exited ${String(code)}`, detail()));
        return;
      }
      const pdf = Buffer.concat(out);
      if (pdf.subarray(0, PDF_MAGIC.length).toString("ascii") !== PDF_MAGIC) {
        reject(new RenderError(
          "renderer produced no PDF",
          `${String(pdf.length)} bytes on stdout; ${detail()}`,
        ));
        return;
      }
      if (pdfEmbedsFiles(pdf)) {
        reject(new RenderError("rendered PDF embeds a file", `${String(pdf.length)} bytes`));
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

/**
 * Whether a render can run here. Never throws -- the tests gate on it.
 *
 * Probes `python3 -c "import weasyprint"` rather than the `weasyprint` executable,
 * because that is what renderPdf actually spawns: a PATH whose python3 cannot import
 * the module would pass a CLI check and then fail every render.
 */
export async function weasyprintAvailable(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("python3", ["-c", "import weasyprint"], { stdio: "ignore" });
    child.on("error", () => { resolve(false); });
    child.on("close", (code) => { resolve(code === 0); });
  });
}
