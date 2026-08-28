import { spawn } from "node:child_process";

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
 * 20s, which is 34x the measurement rather than a guess at one. Measured on the
 * server's WeasyPrint 57.2: a one-page quote with a logo, eight line items and a
 * page-level stylesheet takes 570-580ms end to end, most of it the Python
 * interpreter starting. A 435KB, 40-page document takes 3.9s.
 *
 * The cap is therefore the ceiling on a pathological render, not a budget for a
 * normal one. It also bounds how long the issuing transaction holds its row lock
 * on the number sequence, which is why it is not larger still.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 25MB of OUTPUT, against a measured 14,005 bytes for that one-page quote and
 * 120KB for the 40-page one. Three orders of magnitude of headroom: this exists to
 * stop an unbounded stream being accumulated in memory, not to reject a large but
 * legitimate document.
 */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * 2MB of INPUT, and this one is not headroom -- it is chosen to bite at roughly the
 * same document size the timeout does. The realistic quote above is 1.8KB of HTML;
 * 435KB of HTML costs 3.9s and 97MB of RSS, so 2MB is about where a render would
 * approach the 20s ceiling anyway. Rejecting it here makes that failure immediate
 * and free instead of costing 20 seconds and 100+MB first.
 *
 * It is a real limit rather than a formality because templates are user-editable
 * and a merged document is template plus data plus an inlined logo.
 */
const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024;

/** Enough stderr to diagnose a failure, bounded so a chatty child cannot balloon it. */
const STDERR_CAP_BYTES = 8 * 1024;

/** Every conforming PDF starts with this. An exit-0 render that does not is not one. */
const PDF_MAGIC = "%PDF-";

/**
 * The renderer, and the reason this module spawns Python rather than the `weasyprint`
 * CLI. It has THREE controls, because one was not enough and two were not either.
 *
 * The threat is a local file read, not just SSRF. `default_url_fetcher` hands every
 * absolute URI to `urllib.urlopen`, whose opener carries `FileHandler` alongside the
 * HTTP ones, and WeasyPrint writes `<link rel=attachment>` targets into the PDF's
 * /EmbeddedFiles. Demonstrated on the server against this module's earlier CLI
 * invocation: `<link rel="attachment" href="file:///etc/passwd">` exited 0 and the
 * file came back out of the PDF byte for byte. On a deployment the interesting file
 * is $DATA_DIR/mail.key -- readable by the `conduit` user the API runs as, and with
 * it every stored IMAP and SMTP password.
 *
 * 1. A `url_fetcher` that allowlists `data:` and raises otherwise. The CLI has no
 *    flag for this; the API does, and it replaces the default outright. This covers
 *    images, stylesheets and fonts, on both versions.
 *
 * 2. `rel=attachment` is deleted from the parsed tree before rendering, because
 *    control 1 does NOT reach attachments on every version. Established by a CI run
 *    rather than assumed: 57.2 routes attachments through the document's fetcher,
 *    but on 61.1 `Attachment.__init__` binds `url_fetcher=default_url_fetcher` as a
 *    default argument, so the one passed to `HTML(...)` never arrives and the file
 *    was read with the fetcher recording no calls at all. Stripping the attribute
 *    removes the vector upstream of whichever fetcher a version happens to use.
 *
 * 3. The finished PDF is refused if it contains embedded files at all. This is the
 *    only control that is a statement about the OUTPUT rather than about a mechanism,
 *    so it is the one that would survive a future WeasyPrint growing a new route to
 *    the filesystem. **No test reaches it**, because control 2 closes the only route
 *    HTML currently has -- that is a deliberate backstop, not dead code, and this
 *    comment is the honest record that it is unexercised.
 *
 * A blocked URL EXITS NON-ZERO rather than rendering without the asset. By the time
 * HTML reaches this module, documents-template.ts has stripped every non-`data:` URL,
 * so one arriving here means either an attack or a hole in that sanitiser -- exactly
 * the moment to fail the render, spend no document number, and leave a line in the
 * log, rather than quietly hand back a plausible-looking quote.
 *
 * Kept inline rather than in a checked-in .py file so there is no second artifact for
 * the release tarball to omit and no runtime path to resolve: it ships as part of the
 * compiled JavaScript or not at all.
 */
const RENDER_SCRIPT = `
import io
import re
import sys
import zlib

import weasyprint
from weasyprint.urls import default_url_fetcher

blocked = []


def fetcher(url, timeout=10, ssl_context=None):
    if url.startswith('data:'):
        return default_url_fetcher(url, timeout, ssl_context)
    blocked.append(url[:120])
    raise ValueError('conduit: blocked non-data URL')


def has_embedded_files(raw):
    if b'/EmbeddedFiles' in raw:
        return True
    for match in re.finditer(rb'stream\\r?\\n', raw):
        start = match.end()
        end = raw.find(b'endstream', start)
        if end == -1:
            continue
        try:
            if b'/EmbeddedFiles' in zlib.decompress(raw[start:end]):
                return True
        except zlib.error:
            pass
    return False


document = weasyprint.HTML(
    string=sys.stdin.buffer.read().decode('utf-8'),
    base_url=None,
    url_fetcher=fetcher,
)

for element in document.etree_element.iter():
    rel = element.get('rel')
    if rel and 'attachment' in rel.lower().split():
        del element.attrib['rel']
        blocked.append('rel=attachment on <%s>' % element.tag)

buffer = io.BytesIO()
document.write_pdf(buffer)
pdf = buffer.getvalue()
if blocked:
    sys.stderr.write('conduit-blocked-url: ' + ' | '.join(blocked) + '\\n')
    sys.exit(2)
if has_embedded_files(pdf):
    sys.stderr.write('conduit-blocked-url: PDF contains embedded files\\n')
    sys.exit(2)
sys.stdout.buffer.write(pdf)
`;

/**
 * A cheap second barrier, and NOT the one that matters -- recorded plainly because
 * an earlier version of this file claimed it was.
 *
 * WeasyPrint's fetcher is urllib, and `urlopen` builds its opener with a
 * `ProxyHandler` that reads exactly these variables, so pointing them at a closed
 * loopback port makes an http(s) fetch fail at connect. What that does NOT cover is
 * every other scheme: `file://` goes to `FileHandler` and never consults a proxy at
 * all, which is how the exfiltration above worked underneath these very settings.
 * RENDER_SCRIPT's allowlist is the control; this only narrows what a future edit to
 * that script could reach by accident.
 *
 * Lowercase `http_proxy` is the one that counts (`getproxies_environment` ignores the
 * uppercase form when REQUEST_METHOD is set, per CVE-2016-1000110); the uppercase
 * pair is here for anything else in the child that reads them. `no_proxy` is emptied
 * to override an inherited `no_proxy=*`, not because empty differs from absent.
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
    child.on("error", (e) => { fail("could not start the renderer", e.message); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const stderr = detail();
      if (stderr.includes("conduit-blocked-url:")) {
        reject(new RenderError("document referenced a blocked URL", stderr));
        return;
      }
      if (code !== 0) {
        reject(new RenderError(`renderer exited ${String(code)}`, stderr));
        return;
      }
      const pdf = Buffer.concat(out);
      if (pdf.subarray(0, PDF_MAGIC.length).toString("ascii") !== PDF_MAGIC) {
        reject(new RenderError(
          "renderer produced no PDF",
          `${String(pdf.length)} bytes on stdout; ${stderr}`,
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
