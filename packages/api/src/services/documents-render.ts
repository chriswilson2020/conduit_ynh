import { spawn } from "node:child_process";
import { inflateSync } from "node:zlib";

/** A render that failed for any reason: spawn, timeout, non-zero exit, or a cap. */
export class RenderError extends Error {
  constructor(message: string, readonly detail: string = "") {
    super(message);
    this.name = "RenderError";
  }
}

/**
 * Raised when no render slot came free in time. A SUBCLASS so the route can answer
 * 503 rather than 422: nothing about the document was wrong, the process was simply
 * saturated, and retrying is the correct client behaviour. Extending RenderError
 * keeps every `instanceof RenderError` site true of it, so an unhandled path degrades
 * to the generic refusal rather than a 500.
 */
export class RenderBusyError extends RenderError {
  constructor(message: string, detail = "") {
    super(message, detail);
    this.name = "RenderBusyError";
  }
}

export interface RenderOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxInputBytes?: number;
  queueTimeoutMs?: number;
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
 * RE-MEASURED, AND THE TABLE THAT WAS HERE WAS WRONG. Every figure below comes from
 * the SHIPPED script on the server (Debian 12, WeasyPrint 57.2), driven through this
 * module's own renderPdf, with the child's peak RSS sampled from /proc every 50ms.
 * The previous table said 128KB cost 5.2s and 157MB; it costs 7.3s and 238MB for the
 * same shape, and more than that for a worse one.
 *
 *   input   shape                       time     peak RSS   rows
 *   32 KB   table (quote-shaped rows)    2.2 s     102 MB    ~330
 *   64 KB   table                        4.0 s     148 MB    ~660
 *   128 KB  table                        7.3 s     238 MB   1,300   <- the cap
 *   256 KB  table                       15.4 s     416 MB   2,600
 *   128 KB  prose (no table at all)      1.8 s      84 MB       0
 *   128 KB  **dense** (19-byte rows)    10.0 s     332 MB   6,897
 *
 * **THE ROW COUNT DRIVES THE COST MORE THAN THE BYTE COUNT DOES, and that is why the
 * worst case at this cap is 332MB rather than 238MB.** The same 128KB is 84MB as
 * prose and 332MB as a table of minimal rows -- a factor of four for the same input
 * size. A template is user-editable and may be nothing but `<tr><td>x</td></tr>`, so
 * 332MB is the number the concurrency limit has to be built on, not the 157MB an
 * earlier measurement of a friendlier document produced.
 *
 * **The timeout cannot bound memory, because the expensive documents are the ones
 * fast enough to survive it.** Every row above is inside the 20s ceiling, including
 * the 256KB one that costs 416MB. Only a size cap catches the ones that succeed.
 *
 * A one-page quote is ~2.4KB, so this is ~50x a real document -- and the headroom is
 * for the org profile's logo, which arrives inlined as a `data:` URI at 4/3 of its
 * stored size, and for the notes, terms and line items that share the same budget.
 * `@conduit/shared`'s DOCUMENT_CONTENT_BUDGET_BYTES divides this figure up; if this
 * cap moves, every constant there moves with it.
 */
const DEFAULT_MAX_INPUT_BYTES = 128 * 1024;

/**
 * TWO CONCURRENT RENDERS, AND THIS IS THE THING THAT MAKES `ram.runtime` TRUE.
 *
 * **IT WAS THREE, AND THREE WAS BUILT ON A MEASUREMENT THAT WAS 2.1x TOO LOW.** The
 * arithmetic was 400M (Node) + 3 x 157MB = 900M declared. A render at the input cap
 * costs 332MB in the worst shape (see the table above), so that same arithmetic is
 * 400 + 3 x 332 = 1,396M -- on a 3819MB server with NO SWAP, where exceeding the
 * budget is an OOM kill rather than a slowdown.
 *
 * Two rather than three, and the declaration raised to 1100M: 400 + 2 x 332 = 1,064M.
 * The alternative was to keep three and declare the 1,396M computed above, which is
 * more than a third of the machine for a feature one person uses at a time. Concurrency is only reached at all
 * when two quotes are dated in different years, or when something other than issuing
 * renders; the issuing path's own row lock serialises everything else.
 *
 * YunoHost sets no cgroup from `ram.runtime` and does not evaluate it at install, so
 * the declaration is documentation and THIS is the enforcement.
 *
 * **The input cap is the lever; this is the multiplier. Move either and recompute the
 * other**, and the manifest with them -- documents-render.test.ts asserts the three
 * still agree.
 *
 * IT LIVES IN renderPdf RATHER THAN IN THE ISSUING TRANSACTION because the budget is
 * a property of this process, not of quotes: a template preview, a second document
 * type, or a batch re-issue would each need the same bound, and a limit a caller has
 * to remember to apply is a limit that holds until somebody adds a call site.
 *
 * **THE ISSUING PATH DOES REACH THE QUEUE, and an earlier version of this comment
 * said it did not.** The claim was that the number sequence's row lock already
 * serialises quotes to one at a time -- true only for one (type, year), and the year
 * comes from the CALLER's issue date. Measured from the children, and asserted
 * permanently in documents.test.ts: two quotes in different years render
 * concurrently, two quotes in the same year do not. Anything past the cap waits, and
 * each waiter holds its row lock and a pooled connection while it does.
 *
 * The figure this paragraph used to carry -- "six across six years reach exactly
 * three, with three transactions waiting" -- was measured when the cap was 3, and it
 * survived round 2 lowering the cap to 2. A measurement is only true at the constant
 * it was taken at, so the sentence above names neither number and points at the
 * tests, which are parametrised on RENDER_MAX_CONCURRENCY and cannot go stale the
 * same way.
 *
 * That is why the wait is bounded. Without RENDER_QUEUE_TIMEOUT_MS the queue wait
 * precedes the render timeout and is itself unbounded, so "the transaction's lock
 * hold is bounded by the render timeout" would be false: with ten pooled connections
 * and ten distinct years, ten transactions could sit on the queue indefinitely and
 * stall every other request in the API. With it, the worst lock hold is the queue
 * timeout plus the render timeout, and a saturated renderer answers 503 rather than
 * hanging.
 */
export const RENDER_MAX_CONCURRENCY = 2;

/**
 * How long a render will wait for a slot before giving up.
 *
 * 10s is about fifteen one-page quotes' worth of queue and half the render timeout.
 * It is not tuned against load, because there is none to measure: it exists to make
 * the bound on the issuing transaction's lock hold FINITE (10s + 20s), which is the
 * property, rather than to pick the optimum queue depth.
 */
export const RENDER_QUEUE_TIMEOUT_MS = 10_000;

interface RenderWaiter {
  /** Settled already -- by a granted slot or by the timeout. Never granted twice. */
  done: boolean;
  grant: () => void;
}

let rendersInFlight = 0;
const rendersWaiting: RenderWaiter[] = [];

/**
 * Take a render slot, waiting up to `timeoutMs` if every slot is busy. FIFO, so a
 * queued render cannot be starved by a steady arrival of new ones.
 *
 * A timed-out waiter removes ITSELF from the queue rather than being skipped later:
 * leaving it there would make releaseRenderSlot hand the slot to a caller that is no
 * longer listening, and the count would never come back down.
 *
 * THE `splice` AND THE `done` CHECK IN releaseRenderSlot ARE ONE MECHANISM WITH TWO
 * HALVES, AND NEITHER IS INDIVIDUALLY TESTABLE. Deleting the splice survives every
 * test, because the `done` check then catches the stale waiter; deleting the `done`
 * check survives too, because the splice means no stale waiter is ever reached.
 * Deleting BOTH leaks a slot per timeout permanently. That is what redundancy looks
 * like from a test suite, and it is recorded here rather than left for a reviewer to
 * rediscover -- the splice keeps the queue's length honest (a caller that gave up is
 * not waiting), and the flag is what makes the invariant local to the object rather
 * than a property of two functions agreeing.
 */
async function acquireRenderSlot(timeoutMs: number): Promise<void> {
  if (rendersInFlight < RENDER_MAX_CONCURRENCY) {
    rendersInFlight += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: RenderWaiter = { done: false, grant: () => { /* replaced below */ } };
    const timer = setTimeout(() => {
      if (waiter.done) return;
      waiter.done = true;
      const at = rendersWaiting.indexOf(waiter);
      if (at !== -1) rendersWaiting.splice(at, 1);
      reject(new RenderBusyError(
        "the renderer is busy",
        `waited ${String(timeoutMs)}ms for one of ${String(RENDER_MAX_CONCURRENCY)} slots`,
      ));
    }, timeoutMs);
    waiter.grant = () => { clearTimeout(timer); resolve(); };
    rendersWaiting.push(waiter);
  });
}

/**
 * Give the slot back -- to the next waiter if there is one, which is why the counter
 * is left alone in that branch: the slot is handed over rather than freed and
 * re-taken, so no third caller can slip in between the two halves.
 */
function releaseRenderSlot(): void {
  for (;;) {
    const next = rendersWaiting.shift();
    if (next === undefined) {
      rendersInFlight -= 1;
      return;
    }
    if (next.done) continue;
    next.done = true;
    next.grant();
    return;
  }
}

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
 *
 * At most RENDER_MAX_CONCURRENCY of these run at once, process-wide; the next one
 * waits up to RENDER_QUEUE_TIMEOUT_MS and then rejects with a RenderBusyError. See those
 * two constants for the memory arithmetic they keep true and the bound they put on a
 * caller's transaction.
 */
export async function renderPdf(html: string, options: RenderOptions = {}): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  const queueTimeoutMs = options.queueTimeoutMs ?? RENDER_QUEUE_TIMEOUT_MS;

  const inputBytes = Buffer.byteLength(html, "utf8");
  if (inputBytes > maxInputBytes) {
    throw new RenderError(
      "document is too large to render",
      `${String(inputBytes)} bytes of HTML, limit ${String(maxInputBytes)}`,
    );
  }

  // After the input cap, before the spawn: a document that is too large is refused
  // outright rather than queued for a slot it would only waste.
  await acquireRenderSlot(queueTimeoutMs);
  try {
    return await spawnRender(html, { timeoutMs, maxBytes });
  } finally {
    releaseRenderSlot();
  }
}

/** The subprocess itself. Split out so the slot's try/finally cannot grow a path
 * that leaks one. */
async function spawnRender(
  html: string, { timeoutMs, maxBytes }: { timeoutMs: number; maxBytes: number },
): Promise<Buffer> {
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
