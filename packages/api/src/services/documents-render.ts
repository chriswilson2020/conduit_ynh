import { spawn } from "node:child_process";
import { inflateSync } from "node:zlib";
import {
  renderInputCost, RENDER_IMAGE_CAP_BYTES, RENDER_IMAGE_PIXEL_CAP, RENDER_MARKUP_CAP_BYTES,
} from "@conduit/shared";

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
  maxImageBytes?: number;
  maxImagePixels?: number;
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
 * 87,357 BYTES OF MARKUP. **This, not the timeout, is what bounds a render's cost.**
 *
 * RE-MEASURED FOR v1.0.1, AND TWO FIGURES IN THE TABLE THAT WAS HERE WERE STALE.
 * Every figure below comes from the same method as before -- the server (Debian 12,
 * WeasyPrint 57.2, Pillow 9.4.0), driven through this module's own renderPdf, with
 * the child's peak RSS sampled from /proc every 50ms -- re-run against the shapes
 * this release makes possible. The dense row at 128KB was recorded as 10.0s/332MB
 * and measures 11.2s/345MB on two consecutive runs; prose was recorded as 1.8s/84MB
 * and measures 1.4s/71MB. The conclusions are unchanged; the numbers are not, and
 * the numbers are what the manifest is built from.
 *
 *   markup  images                        time     peak RSS   rows
 *   128 KB  --      dense (19-byte rows) 11.2 s     345 MB   6,897   <- v1.0.0's cap
 *   128 KB  --      prose                 1.4 s      71 MB       0
 *   87 KB   --      dense                 7.0 s     250 MB   4,596   <- this cap
 *   small   2.8Mpx  a real 300KB logo     0.7 s      79 MB       0
 *   87 KB   2.8Mpx  that logo, dense      6.9 s     263 MB   4,596
 *   87 KB   16Mpx   a logo at both caps   7.5 s     353 MB   4,596   <- the worst
 *   87 KB   20Mpx   what the bound stops  7.3 s     384 MB   4,596
 *   128 KB  16Mpx   the rejected design  11.5 s     440 MB   6,897
 *
 * **THE ROW COUNT DRIVES THE COST MORE THAN THE BYTE COUNT DOES, and that is why the
 * worst case here is 250MB of rows rather than 71MB of prose for the same bytes.** A
 * template is user-editable and may be nothing but `<tr><td>x</td></tr>`, so the
 * dense row is the number the concurrency limit has to be built on.
 *
 * **AND THE IMAGE HALF IS BOUNDED BY PIXELS, NOT BY BYTES**, because a file's size
 * says nothing about the raster it decodes to: 12,227 bytes of 1-bit PNG is
 * 10,000 x 10,000 and costs 535MB. See DEFAULT_MAX_IMAGE_PIXELS.
 *
 * **The timeout cannot bound memory, because the expensive documents are the ones
 * fast enough to survive it.** Every row above is inside the 20s ceiling, including
 * the 440MB one. Only a size cap catches the ones that succeed.
 *
 * A one-page quote is ~2.4KB of markup, so this is ~36x a real document.
 * `@conduit/shared`'s RENDER_MARKUP_CAP_BYTES is the same figure and the three
 * allowances it is the sum of; if this cap moves, every constant there moves with it.
 */
const DEFAULT_MAX_INPUT_BYTES = RENDER_MARKUP_CAP_BYTES;

/**
 * 409,623 BYTES OF `data:` IMAGE PAYLOAD, on top of the markup cap: one logo at
 * MAX_LOGO_BYTES, inlined at 4/3 of its stored size.
 *
 * IT IS A SEPARATE ALLOWANCE BECAUSE BASE64 CANNOT BE A TABLE ROW. The alphabet has
 * no `<` in it, so a byte inside a payload cannot open a tag however it was smuggled
 * in -- which is what makes it safe to let this half be five times the other without
 * five times the memory. Measured: the same 87KB of rows costs 250MB with no image
 * and 353MB with a logo at both this cap and the pixel one.
 */
const DEFAULT_MAX_IMAGE_BYTES = RENDER_IMAGE_CAP_BYTES;

/**
 * 16,000,000 PIXELS ACROSS EVERY IMAGE IN THE DOCUMENT, AND THIS IS THE ONE A BYTE
 * CAP CANNOT MAKE.
 *
 * Peak RSS is about 56MB + 7.65MB per megapixel -- 3Mpx costs 78MB, 45Mpx costs
 * 401MB -- and a PNG's file size predicts none of it. Measured on the server:
 *
 *   12,227 B   1-bit PNG, 10,000 x 10,000 (100Mpx)    535 MB
 *   20,625 B   1-bit PNG, 13,000 x 13,000 (169Mpx)    864 MB
 *   316,191 B  RGB PNG,   10,000 x 10,000             821 MB
 *   1,209,677 B          20,000 x 20,000 (400Mpx)      67 MB, image DROPPED
 *
 * The last one is Pillow refusing over 178,956,970 pixels (twice its own
 * MAX_IMAGE_PIXELS) and rendering the page without the image. That refusal is the
 * only thing that stood between v1.0.0 and a gigabyte of RSS, and it does not fire
 * until 169Mpx has already cost 864MB.
 *
 * **THE SECOND ROW FITS IN A TEMPLATE, WHICH IS WHY THIS IS ENFORCED HERE AND NOT
 * ONLY AT THE UPLOAD.** 20,625 bytes is 27,522 characters of base64, and
 * MAX_TEMPLATE_BYTES is 16,384 -- so the 100Mpx/12,227-byte row does fit, in a
 * document template any user can edit, on a v1.0.0 install, today. The logo's own
 * bound lives in `logoDataUriProblem` and refuses this at the upload; this one is
 * what covers the template, and what covers a logo that was already stored before
 * the upload gate existed.
 *
 * **IT COVERS THE TEMPLATE ONLY BECAUSE `renderInputCost` MATCHES EVERY `data:` URI
 * RATHER THAN FOUR SPELLINGS OF ONE, AND THE FIRST VERSION DID NOT.** A spec reviewer
 * wrote `data:image/bmp;base64,` in front of the same PNG: charged zero pixels,
 * counted as cheap markup, rendered at 534MB, past all three caps. Five more
 * respellings did the same. That is why the scanner sniffs bytes now and why the
 * fetcher above allowlists formats -- the two together are the bound, and neither is
 * it alone.
 */
const DEFAULT_MAX_IMAGE_PIXELS = RENDER_IMAGE_PIXEL_CAP;

/**
 * TWO CONCURRENT RENDERS, AND THIS IS THE THING THAT MAKES `ram.runtime` TRUE.
 *
 * **IT WAS THREE, AND THREE WAS BUILT ON A MEASUREMENT THAT WAS 2.1x TOO LOW.** The
 * arithmetic was 400M (Node) + 3 x 157MB = 900M declared. A render at the caps costs
 * 353MB in the worst shape (see the table above), so that same arithmetic is
 * 400 + 3 x 353 = 1,459M -- on a 3819MB server with NO SWAP, where exceeding the
 * budget is an OOM kill rather than a slowdown.
 *
 * Two rather than three, and the declaration is 1150M: 400 + 2 x 353 = 1,106M. It was
 * 1100M for v1.0.0's worst case, which the same method now measures at 345MB rather
 * than the 332MB recorded -- 400 + 2 x 345 = 1,090M, still true, and the 50M this
 * release adds buys the logo's pixel allowance.
 * The alternative was to keep three and declare the 1,459M computed above, which is
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
/** The render asked for more memory than the child is allowed. */
const EXIT_OUT_OF_MEMORY = 4;

/**
 * **512MB PER RENDER, ENFORCED BY THE KERNEL ON THE CHILD ITSELF, AND THIS IS THE
 * ONLY BOUND HERE THAT DOES NOT DEPEND ON PREDICTING WHAT A DOCUMENT DECODES TO.**
 *
 * THREE REVIEW ROUNDS FOUND FOUR WAYS PAST THE ARITHMETIC, all of them the same
 * shape: this module's reader disagreeing with what Pillow actually does.
 *
 *   round 1  `data:image/bmp;base64,<pngbytes>` and five more respellings   534MB
 *   round 2  a 334-byte JPEG2000 that decodes to 36 megapixels          unbounded
 *   round 3  a GIF whose logical screen says 1x1 and whose first frame
 *            is 13000x13000 -- charged ONE pixel                           703MB
 *   round 3  one space inside the base64, which the decoder ignores and
 *            the scanner read as the end of the payload                    534MB
 *
 * There would have been a fifth. Pillow opens forty formats and this module was
 * reimplementing its header parsing from the outside, which is a losing position by
 * construction: every bound was a prediction, and a prediction only has to be wrong
 * once. This is not a prediction. Whatever the document contains, the child cannot
 * allocate past this, because the kernel will not let it.
 *
 * MEASURED, on the server, through this module's own renderPdf, sampling /proc every
 * 25ms, with the limit in place:
 *
 *   document                                 RSS     VmData    outcome
 *   a plain quote                             59MB     54MB    renders
 *   a real 293KB 2000x1400 logo               79MB     74MB    renders
 *   87,357 bytes of minimal table rows       252MB    249MB    renders
 *   THE LEGITIMATE WORST CASE                340MB    335MB    renders
 *   the GIF frame-extent bomb (round 3)       80MB      --     refused, clean
 *   the whitespace bomb (round 3)            189MB      --     refused, clean
 *
 * 512MB is 1.53x the worst legitimate document measured, whose spread across runs is
 * about 7%. It is deliberately not tighter: CI renders on WeasyPrint 61.1 against
 * this server's 57.2, and a limit that fitted only one of them would be a limit that
 * fails a release.
 *
 * **RLIMIT_DATA RATHER THAN RLIMIT_AS, AND THE DIFFERENCE IS WHAT `ram.runtime` CAN
 * HONESTLY SAY.** Address space carries a 314MB floor here -- the interpreter, cairo,
 * pango and the font stack -- of which about 59MB is ever resident, so an AS limit
 * that cleared the same documents would be 900MB and `400 + 2 x 900` would declare
 * 2.2GB of RAM for an app whose worst measured pair of renders is 1,080MB. RLIMIT_DATA
 * bounds brk and private anonymous mappings, which since Linux 4.7 is where a decoded
 * raster lives (Debian 12 runs 6.1; the oldest Debian YunoHost supports runs 5.10).
 * What it does not bound is file-backed pages -- shared libraries and fonts -- which
 * measured under 20MB resident and are shared between the children anyway.
 *
 * So `ram.runtime = 400 + RENDER_MAX_CONCURRENCY x 512 = 1,424M`, and
 * documents-render.test.ts asserts the manifest's literal equals that arithmetic
 * exactly. For the first time that declaration is a ceiling something enforces rather
 * than a figure somebody hopes is still true.
 *
 * SET INSIDE THE CHILD, first thing, before `import weasyprint`. A shell wrapper
 * (`sh -c 'ulimit -d N; exec python3 ...'`) would work too and is what every reviewer
 * used to run these bombs safely, but it puts a shell between this module and the
 * process it kills on a timeout, and the suite shadows `python3` on PATH. Setting it
 * here covers the imports as well as the render.
 */
export const RENDER_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

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
 *    **AND, SINCE v1.0.1, ALLOWLISTING THE PAYLOAD'S FORMAT AS WELL AS THE SCHEME --
 *    which is what makes the pixel bound sound rather than approximately sound.**
 *    Pillow on this server opens forty formats, and it sniffs: a **334-byte
 *    JPEG2000** decodes to 36 megapixels, which is **107,784 pixels per byte**.
 *    `renderInputCost` charges an unidentifiable payload 8,256 pixels per byte -- the
 *    most any DEFLATE-based format can reach -- so that one would have been charged
 *    3.7M against a 16M cap and waved through. No per-byte arithmetic can bound a
 *    wavelet codec, so the fix is not a bigger number: it is refusing to decode
 *    anything that is not one of the four formats the pixel bound can actually read.
 *    Sniffed here on the bytes, exactly as Pillow would, so there is no spelling of a
 *    media type that changes the answer.
 *
 *    What this gives up is an embedded font or stylesheet in a document template.
 *    Neither was ever a documented capability, the shipped template uses neither, and
 *    a `data:` payload nothing can identify is precisely the case where what the
 *    renderer would do with it is unknown. It also finishes the SVG exclusion the
 *    spec asked for: `data:image/svg+xml` in a TEMPLATE was still drawn as vector art
 *    until this, since only the logo upload checked signatures.
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
import resource
import sys

# THE BUDGET, BEFORE ANYTHING THAT COULD SPEND IT. Both limits are set to the same
# figure so nothing can raise it back afterwards, and it is in place before weasyprint
# is imported -- so the interpreter, cairo, pango and the font stack are inside the
# budget rather than beside it. See RENDER_MEMORY_LIMIT_BYTES.
LIMIT = ${String(RENDER_MEMORY_LIMIT_BYTES)}
resource.setrlimit(resource.RLIMIT_DATA, (LIMIT, LIMIT))

import weasyprint
from weasyprint.urls import default_url_fetcher

blocked_urls = []
blocked_attachments = []

IMAGE_SIGNATURES = (
    b'\\x89PNG\\r\\n\\x1a\\n',
    b'\\xff\\xd8\\xff',
    b'GIF87a',
    b'GIF89a',
)


def is_supported_image(data):
    if not isinstance(data, bytes):
        return False
    if data.startswith(IMAGE_SIGNATURES):
        return True
    return data[:4] == b'RIFF' and data[8:12] == b'WEBP'


def fetcher(url, timeout=10, ssl_context=None):
    if not url.startswith('data:'):
        blocked_urls.append(url[:120])
        raise ValueError('conduit: blocked non-data URL')
    result = default_url_fetcher(url, timeout, ssl_context)
    data = result.get('string')
    if data is None:
        data = result['file_obj'].read()
    if not is_supported_image(data):
        blocked_urls.append(url[:120])
        raise ValueError('conduit: data: URI is not a PNG, JPEG, GIF or WEBP')
    return {'string': data, 'mime_type': result.get('mime_type')}


try:
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
except MemoryError:
    # A DISTINCT EXIT CODE RATHER THAN A TRACEBACK, so the parent can say which of the
    # bounds was hit in a sentence somebody can act on. Partial bytes may already be on
    # stdout; a non-zero exit means the parent rejects rather than resolving, so they
    # are never mistaken for a PDF.
    sys.stderr.write('conduit-out-of-memory\\n')
    sys.exit(4)

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
 * **AND IT SEARCHES PDF SYNTAX RATHER THAN THE WHOLE FILE, BECAUSE A THREE-BYTE
 * NEEDLE IN A BINARY HAYSTACK FIRES ON ITS OWN.** v1.0.0 searched the raw bytes,
 * stream contents included, and a 287,090-byte logo measured during v1.0.1's work
 * produced a PDF whose compressed image stream happened to contain `/EF`. The render
 * was refused with "rendered PDF embeds a file", and it would have been refused every
 * time: the same logo makes the same bytes, so that logo could never have been used
 * again. At a 32KB logo the odds of it are about 0.2% per image and nobody hit it; at
 * 300KB they are about 1.7%, which over a few hundred installs is somebody.
 *
 * So a stream's BODY is excluded from the raw search, and inflated bodies are
 * searched only when the object's dictionary does not say `/Image`. Neither exclusion
 * can hide the thing this looks for: an `/EF` or a `/Filespec` is a key in a
 * DICTIONARY, and a dictionary is never inside a stream body -- except in a
 * `/Type /ObjStm`, which is exactly the case the inflating branch covers and which
 * never carries `/Image`. What is excluded is raster data, which cannot be a file
 * specification and can only ever spell one by accident.
 *
 * This is the only control that is a statement about the OUTPUT rather than about a
 * mechanism, which is the point of it: it is what would still hold if a future
 * WeasyPrint grew a third route to the filesystem.
 */
export function pdfEmbedsFiles(pdf: Buffer): boolean {
  const needles = ["/EF", "/Filespec"];
  const hit = (haystack: Buffer): boolean => needles.some((n) => haystack.includes(n));

  // Everything that is not a stream body, joined. The joins land between "stream\n"
  // and "endstream", so no needle can be manufactured by the concatenation itself.
  const syntax: Buffer[] = [];
  let from = 0;
  let at = 0;
  for (;;) {
    const start = pdf.indexOf("stream", at);
    if (start === -1) break;
    const end = pdf.indexOf("endstream", start);
    if (end === -1) break;
    let body = start + "stream".length;
    if (pdf[body] === 0x0d) body += 1;
    if (pdf[body] === 0x0a) body += 1;
    syntax.push(pdf.subarray(from, body));

    // The dictionary this stream belongs to: from its object header, or a generous
    // window back if the file is malformed enough not to have one.
    const objAt = pdf.lastIndexOf("obj", start);
    const dict = pdf.subarray(objAt === -1 ? Math.max(0, start - 4096) : objAt, start);
    if (!dict.includes("/Image")) {
      try {
        if (hit(inflateSync(pdf.subarray(body, end)))) return true;
      } catch {
        // Not a Flate stream, or not a stream at all. Keep looking.
      }
    }
    from = end;
    // Past the whole "endstream" keyword, not one byte into it: resuming at end+1
    // makes the next search match the "stream" inside it, whose paired "endstream"
    // is the FOLLOWING object's -- which silently skips every other stream.
    at = end + "endstream".length;
  }
  syntax.push(pdf.subarray(from));
  return hit(Buffer.concat(syntax));
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
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxImagePixels = options.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS;
  const queueTimeoutMs = options.queueTimeoutMs ?? RENDER_QUEUE_TIMEOUT_MS;

  // THREE CAPS, ON THE ONE THING THAT ARRIVES: the markup, which is where the rows
  // are; the image payload, which cannot contain a row; and the pixels those images
  // decode to, which is the only one of the three that a file's size does not
  // predict. Each is reported on its own, because "too large" over a document that
  // is 3KB of markup and one enormous image is a sentence about nothing.
  const cost = renderInputCost(html);
  if (cost.markupBytes > maxInputBytes) {
    throw new RenderError(
      "document is too large to render",
      `${String(cost.markupBytes)} bytes of HTML, limit ${String(maxInputBytes)}`,
    );
  }
  if (cost.imageBytes > maxImageBytes) {
    throw new RenderError(
      "document is too large to render",
      `${String(cost.imageBytes)} bytes of inline image, limit ${String(maxImageBytes)}`,
    );
  }
  if (cost.imagePixels > maxImagePixels) {
    // The count of unidentified payloads is in the sentence because the two ways to
    // reach this line need different fixes: a picture with too many pixels wants a
    // smaller picture, and a payload nothing could identify wants removing. Without
    // it, an embedded font reads as a mysteriously enormous image.
    const unknown = cost.unreadableImages === 0 ? ""
      : `; ${String(cost.unreadableImages)} of them could not be identified as a PNG, `
        + "JPEG, GIF or WEBP and are charged what their bytes could decode to";
    throw new RenderError(
      "document is too large to render",
      `${String(cost.imagePixels)} pixels across ${String(cost.images)} inline image(s), `
      + `limit ${String(maxImagePixels)}${unknown}`,
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
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === EXIT_BLOCKED_URL || code === EXIT_BLOCKED_ATTACHMENT) {
        reject(new RenderError("document referenced a blocked resource", detail()));
        return;
      }
      // THE MEMORY CEILING, REPORTED AS ITSELF. Without this arm it is
      // "renderer exited 4" with a traceback, which tells a user nothing about what
      // to change. The route maps it to a 4xx naming the document, not a 500.
      if (code === EXIT_OUT_OF_MEMORY) {
        reject(new RenderError(
          "document needed more memory than a render is allowed",
          `${String(RENDER_MEMORY_LIMIT_BYTES)} bytes; ${detail()}`,
        ));
        return;
      }
      // A SIGNAL IS NOT AN EXIT CODE, and `code` is null when one arrives -- which is
      // what a C-level allocation failure inside the image decoder looks like, as
      // opposed to a MemoryError Python could raise. Naming it beats "exited null".
      if (signal !== null) {
        reject(new RenderError(`renderer was killed by ${signal}`, detail()));
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
