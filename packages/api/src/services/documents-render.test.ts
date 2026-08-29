import { spawn } from "node:child_process";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  renderInputCost, RENDER_IMAGE_CAP_BYTES, RENDER_MARKUP_CAP_BYTES,
} from "@conduit/shared";
import { withPythonStub, writePythonStub } from "../test/python-stub.js";
import {
  pdfEmbedsFiles, renderPdf, RenderBusyError, RenderError, RENDER_MAX_CONCURRENCY,
  RENDER_QUEUE_TIMEOUT_MS, weasyprintAvailable,
} from "./documents-render.js";

/**
 * This file is in three parts.
 *
 * The STUB part shadows `python3` on PATH with a shell script that behaves the way a
 * real renderer would when it goes wrong, and runs everywhere -- including on a
 * machine with no WeasyPrint, which is where the failure paths would otherwise never
 * be executed at all. Node resolves a bare command name against `env.PATH` at spawn
 * time and renderPdf builds the child's env from `process.env`, so prepending a
 * directory here is enough to intercept it. Fifteen tests below do that.
 *
 * The BACKSTOP part tests `pdfEmbedsFiles` directly on bytes. It is a pure function
 * and most of its cases need no renderer at all -- which is the point: an earlier
 * version of this control lived inside the Python and was reachable only through a
 * subprocess behind two controls that short-circuit first, so its needle was wrong
 * for a year of nobody noticing. (It was wrong for about an hour, in fact, but only
 * because a reviewer went looking with a payload the suite never sent.)
 *
 * The REAL part needs WeasyPrint and is gated on it, so a developer without it still
 * gets a green suite. That gate is NOT the MAIL_IT pattern, which is an explicit
 * opt-in: this one probes, so it would skip silently if a packaging change ever
 * stopped delivering the binary. The `runIf(CI)` tests are what make that loud.
 */

const stubDir = mkdtempSync(join(tmpdir(), "conduit-render-"));
const HAVE_WEASYPRINT = await weasyprintAvailable();
const itReal = HAVE_WEASYPRINT ? it : it.skip;

/**
 * Push a file's atime a day into the past, leaving mtime alone.
 *
 * Two reasons, and the first is what made an earlier version of this file skip every
 * read test on the server. A freshly written file has atime == mtime == now, so the
 * atime a read then writes lands in the same millisecond and `atimeMs` does not
 * visibly move. Backdating makes the delta a day rather than a rounding error.
 * Second, `relatime` -- the usual default -- only refreshes atime when it is no later
 * than mtime, which this guarantees rather than assumes.
 */
function backdateAtime(path: string): void {
  const mtime = statSync(path).mtime;
  utimesSync(path, new Date(Date.now() - 86_400_000), mtime);
}

/**
 * Whether reading a file visibly advances its atime here.
 *
 * This is the suite's only honest way to see a read: it catches an `open` by ANY code
 * path, where watching a loopback server catches only an http fetch that got past the
 * proxy variables -- and those variables stop the request before it could arrive, so
 * an assertion built on them proves nothing at all. That mistake is why this exists.
 *
 * `relatime` (the usual default) updates atime when the old atime is no later than
 * mtime, which is true for a file just written -- so every read test below writes a
 * FRESH file first. A `noatime` mount would silently defeat all of it, hence the
 * self-test rather than an assumption.
 */
const ATIME_WORKS = ((): boolean => {
  const probe = join(stubDir, "atime-self-test");
  writeFileSync(probe, "probe");
  backdateAtime(probe);
  const before = statSync(probe).atimeMs;
  readFileSync(probe);
  return statSync(probe).atimeMs > before;
})();
const itReads = HAVE_WEASYPRINT && ATIME_WORKS ? it : it.skip;

const markerPath = join(stubDir, "the-child-survived");

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

/** Write an executable `python3` into a fresh directory and return that directory.
 * The mechanism moved to test/python-stub.ts when documents.test.ts needed the same
 * interception to test the issuing transaction's failure paths without a binary. */
function stub(body: string): string {
  return writePythonStub(stubDir, body);
}

/** Run `fn` with `dir` at the front of PATH, or as the whole of PATH when replacing. */
async function onPath<T>(dir: string, fn: () => Promise<T>, replace = false): Promise<T> {
  return await withPythonStub(dir, fn, replace);
}

/** A fresh file with known contents, so relatime will report the next read. */
function freshSecret(name: string): { path: string; atime: number } {
  const path = join(stubDir, `${name}-${String(Date.now())}`);
  writeFileSync(path, "conduit-secret-marker-9f3a\n", { mode: 0o600 });
  backdateAtime(path);
  return { path, atime: statSync(path).atimeMs };
}

// ------------------------------------------------------------- failure paths

describe("renderPdf failure paths", () => {
  it("reports a non-zero exit and carries the child's stderr", async () => {
    const dir = stub("echo 'Fatal: no font found' >&2\nexit 5");
    const error = await onPath(dir, async () =>
      await renderPdf("<html></html>").catch((e: unknown) => e));

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("renderer exited 5");
    expect((error as RenderError).detail).toContain("Fatal: no font found");
  });

  it("survives a child that exits before reading a large stdin", async () => {
    // The write is still in flight when the pipe goes away, which is an EPIPE on
    // stdin. It must not surface as an unhandled 'error' event, and the rejection
    // must be the child's real reason rather than the broken pipe. 80KB is well past
    // the 64KB pipe buffer and inside the 87,357-byte markup cap -- it was 100KB and
    // inside the 128KB cap of the day, which v1.0.1's markup cap is below.
    const dir = stub("echo 'bad input' >&2\nexit 5");
    const big = `<html><body>${"x".repeat(80_000)}</body></html>`;
    const error = await onPath(dir, async () =>
      await renderPdf(big).catch((e: unknown) => e));

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("renderer exited 5");
    expect((error as RenderError).detail).toContain("bad input");
  });

  it("times out, and the child is dead rather than merely abandoned", async () => {
    // The stub touches its marker 700ms in. The timeout fires at 150ms, and the
    // marker is checked at 1200ms -- AFTER the sleep would have completed, which is
    // the only arrangement in which the file's absence is evidence of anything. An
    // earlier version checked at 1s against a 3s sleep, so it passed whether or not
    // the child was ever killed; deleting the SIGKILL left it green.
    const dir = stub(
      `printf '%s' '%PDF-1.7 partial'\nsleep 0.7\ntouch '${markerPath}'`,
    );
    const started = Date.now();
    const error = await onPath(dir, async () =>
      await renderPdf("<html></html>", { timeoutMs: 150 }).catch((e: unknown) => e));

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("render timed out");
    expect(Date.now() - started).toBeLessThan(1000);

    await new Promise((r) => setTimeout(r, 1200));
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

  it("maps the renderer's refusal exit codes by status, not by stderr text", async () => {
    // 2 is a blocked URL and 3 a blocked attachment. Matching a marker string
    // instead would let any child that merely PRINTED one claim the same outcome.
    for (const code of [2, 3]) {
      const dir = stub(`echo 'conduit-blocked-whatever' >&2\nexit ${String(code)}`);
      const error = await onPath(dir, async () =>
        await renderPdf("<html></html>").catch((e: unknown) => e));

      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).message).toBe("document referenced a blocked resource");
    }

    // ...and a child that prints the marker while exiting 0 is not a refusal.
    const liar = stub("echo 'conduit-blocked-url: nope' >&2\nprintf '%s' '%PDF-1.7 ok'\nexit 0");
    const pdf = await onPath(liar, async () => await renderPdf("<html></html>"));
    expect(pdf.toString("ascii")).toBe("%PDF-1.7 ok");
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

  it("applies a default markup cap, which is the bound on what a render costs", async () => {
    // 87,357 bytes, and not a formality: on the server that many bytes of minimal
    // table rows costs 7.0s and 250MB. The authoritative table is in
    // documents-render.ts beside the constant; this comment used to carry a
    // superseded pair (5.2s / 157MB) whose 2.1x understatement is the whole reason
    // the concurrency cap and ram.runtime were redesigned, so restating it here was
    // worse than saying nothing.
    const error = await renderPdf("x".repeat(300_000)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("document is too large to render");
    expect((error as RenderError).detail).toContain(`limit ${String(RENDER_MARKUP_CAP_BYTES)}`);
    expect(RENDER_MARKUP_CAP_BYTES).toBe(87_357);
  });

  /**
   * THE TWO CAPS ARE NOT ONE CAP, and this is the pair of assertions that says so.
   *
   * A document may be 496,980 bytes when 409,623 of them are inside a `data:` URI
   * and 87,357 are not -- and may NOT be 100,000 bytes when all of them are markup.
   * The reason is measured rather than tidy: base64 cannot contain a `<`, so an
   * image payload cannot be a table row, and rows are what a render's memory tracks
   * (87KB of them is 250MB; the same bytes as prose are 71MB).
   */
  it("counts a data: payload against the image cap and not against the markup cap", async () => {
    const payload = "A".repeat(400_000);
    const withImage = `<img src="data:image/png;base64,${payload}">`;
    expect(Buffer.byteLength(withImage, "utf8")).toBeGreaterThan(RENDER_MARKUP_CAP_BYTES);

    // No renderer needed: both of these are decided before the spawn, and there is
    // no stub on PATH.
    const cost = renderInputCost(withImage);
    expect(cost.imageBytes).toBe(400_000);
    expect(cost.markupBytes).toBeLessThan(100);

    // The same bytes as markup are refused.
    const asMarkup = await renderPdf("x".repeat(400_000)).catch((e: unknown) => e);
    expect(asMarkup).toBeInstanceOf(RenderError);
    expect((asMarkup as RenderError).detail).toContain("bytes of HTML");

    // ...and an image payload past ITS cap is refused with its own sentence.
    const tooMuchImage = await renderPdf(
      `<img src="data:image/png;base64,${"A".repeat(RENDER_IMAGE_CAP_BYTES + 4)}">`,
    ).catch((e: unknown) => e);
    expect(tooMuchImage).toBeInstanceOf(RenderError);
    expect((tooMuchImage as RenderError).detail).toContain("bytes of inline image");
  });

  /**
   * THE CAP A BYTE COUNT CANNOT MAKE.
   *
   * The document below is 214 bytes and would decode to 100 megapixels, which cost
   * 535MB when it was measured on the server through this very function. Every byte
   * bound in the process passes it. A 16KB template can carry this, which is why the
   * check is here and not only at the logo upload.
   */
  it("refuses a document by the pixels its images decode to, not by their size", async () => {
    // A PNG header and nothing else: 10,000 x 10,000, in 24 bytes.
    const ihdr = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
      Buffer.from("IHDR", "ascii"),
      Buffer.from([0, 0, 0x27, 0x10, 0, 0, 0x27, 0x10]),
    ]);
    const bomb = `<img src="data:image/png;base64,${ihdr.toString("base64")}">`;
    expect(bomb.length).toBeLessThan(256);

    const error = await renderPdf(bomb).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("document is too large to render");
    expect((error as RenderError).detail).toContain("100000000 pixels");

    // Two images that are each inside the bound and together are not: the cap is on
    // the sum, because the renderer decodes all of them.
    const half = Buffer.concat([
      ihdr.subarray(0, 16), Buffer.from([0, 0, 0x0f, 0xa0, 0, 0, 0x0f, 0xa0]),
    ]);
    const one = `<img src="data:image/png;base64,${half.toString("base64")}">`;
    expect(renderInputCost(one).imagePixels).toBe(16_000_000);
    const pair = await renderPdf(one + one).catch((e: unknown) => e);
    expect(pair).toBeInstanceOf(RenderError);
    expect((pair as RenderError).detail).toContain("2 inline image(s)");

    // Both new bounds are OPTIONS as well as defaults, the way the timeout and the
    // output cap are -- otherwise the only way to test an edge is to build a
    // document at the shipped limit, and a knob nothing turns is a knob nothing
    // checks. One image, under both defaults, refused by each in turn.
    const tight = await renderPdf(one, { maxImagePixels: 15_999_999 }).catch((e: unknown) => e);
    expect((tight as RenderError).detail).toContain("limit 15999999");
    const thin = await renderPdf(one, { maxImageBytes: 8 }).catch((e: unknown) => e);
    expect((thin as RenderError).detail).toContain("bytes of inline image, limit 8");
  });
});

// ------------------------------------------------------- the concurrency bound

describe("renderPdf concurrency", () => {
  /**
   * A stub that records how many copies of itself were running when it started.
   *
   * Each invocation drops a file named for its own pid into `runDir`, counts what is
   * in there, appends that count to `observed`, sleeps, and tidies up. The maximum
   * over `observed` is the highest concurrency the process ever actually reached --
   * measured from the children themselves rather than from a counter inside the
   * module under test, which would only ever agree with itself.
   */
  function concurrencyStub(runDir: string, observed: string, sleepSeconds: string): string {
    return stub([
      `mkdir -p '${runDir}'`,
      `: > '${runDir}'/$$`,
      `ls '${runDir}' | wc -l >> '${observed}'`,
      `sleep ${sleepSeconds}`,
      `rm -f '${runDir}'/$$`,
      "printf '%s' '%PDF-1.7 ok'",
    ].join("\n"));
  }

  function maxObserved(observed: string): number {
    return Math.max(...readFileSync(observed, "utf8").trim().split("\n").map(Number));
  }

  it("runs at most RENDER_MAX_CONCURRENCY renders at once, and really does overlap them", async () => {
    // The bound is what keeps manifest.toml's ram.runtime true on a server with no
    // swap, where exceeding it is an OOM kill rather than a slowdown.
    //
    // BOTH ASSERTIONS ARE LOAD-BEARING, in opposite directions: the ceiling fails if
    // the limiter is removed (six children would run at once), and the floor of 2
    // fails if it is tightened to one, which would otherwise look like a very well
    // behaved bound. The ceiling is spelled as RENDER_MAX_CONCURRENCY rather than as
    // a literal, so lowering the cap cannot leave this description behind -- which is
    // exactly what happened when it went from 3 to 2.
    const runDir = join(stubDir, "conc-run");
    const observed = join(stubDir, "conc-observed");
    writeFileSync(observed, "");
    const dir = concurrencyStub(runDir, observed, "0.5");

    const pdfs = await onPath(dir, async () =>
      await Promise.all(Array.from({ length: 6 }, async () => await renderPdf("<html></html>"))));

    expect(pdfs).toHaveLength(6);
    for (const pdf of pdfs) expect(pdf.toString("ascii")).toBe("%PDF-1.7 ok");
    expect(maxObserved(observed)).toBeLessThanOrEqual(RENDER_MAX_CONCURRENCY);
    expect(maxObserved(observed)).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("gives the slot back when a render fails, rather than wedging the process", async () => {
    // Three failures with no release would leave every later render waiting for a
    // slot that is never coming -- a hang, not an error, and the kind that survives
    // a test suite because a hang looks like a slow machine. The race below turns it
    // into a named failure instead of a timeout.
    const failing = stub("echo 'boom' >&2\nexit 5");
    await onPath(failing, async () => {
      const attempts = Array.from(
        { length: RENDER_MAX_CONCURRENCY + 1 },
        async () => await renderPdf("<html></html>").catch((e: unknown) => e),
      );
      for (const settled of await Promise.all(attempts)) {
        expect(settled).toBeInstanceOf(RenderError);
      }
    });

    const working = stub("printf '%s' '%PDF-1.7 ok'");
    const outcome = await onPath(working, async () => await Promise.race([
      renderPdf("<html></html>").then(() => "rendered"),
      new Promise<string>((r) => setTimeout(() => { r("still waiting for a render slot"); }, 3000)),
    ]));
    expect(outcome).toBe("rendered");
  }, 20_000);

  it("keeps the input cap ahead of the queue: an oversized document is refused, not queued", async () => {
    // Otherwise a document that can never render would occupy a slot for as long as
    // the queue ahead of it takes. Proved by holding every slot with sleeping
    // children and showing the oversized call still returns immediately.
    const runDir = join(stubDir, "cap-run");
    const observed = join(stubDir, "cap-observed");
    writeFileSync(observed, "");
    const dir = concurrencyStub(runDir, observed, "1");

    await onPath(dir, async () => {
      const busy = Array.from(
        { length: RENDER_MAX_CONCURRENCY },
        async () => await renderPdf("<html></html>"),
      );
      const started = Date.now();
      const error = await renderPdf("x".repeat(4096), { maxInputBytes: 1024 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).message).toBe("document is too large to render");
      expect(Date.now() - started).toBeLessThan(500);
      await Promise.all(busy);
    });
  }, 20_000);

  it("grants queued slots in arrival order, so a steady stream cannot starve a waiter", async () => {
    // FIFO WAS ONLY EVER A COMMENT, and the first version of this test was wrong
    // about how to see it. It started six renders, let three queue, and read the
    // order their children appended to a log -- which measures which PROCESS won a
    // start-up race, not which caller was granted a slot. It failed two runs in five
    // with "DFE": the grants were in order and the writes were not.
    //
    // So the grants are separated instead of the observations. The stub takes
    // "<id>:<seconds>" on stdin, logs the id and sleeps. Three holders are submitted
    // ahead of D, E and F, with staggered sleeps, and each queued render runs for
    // 0.1s. The point of the stagger is that ONLY ONE SLOT EVER COMES FREE AT A TIME,
    // whatever the cap is: the holders' sleeps differ by more than a queued render
    // costs, so D, E and F are granted about 100ms apart -- the length of one of
    // them -- against process start-up jitter of a few milliseconds. A stack would
    // answer F, E, D and starve D under a steady arrival rate.
    //
    // The wall-clock times this comment used to name (D at ~0.3s, E at ~0.4s, F at
    // ~0.5s) assumed three slots and three holders that all start at once. At a cap
    // of 2 the third holder is itself the first waiter, so every absolute figure
    // moved; the 100ms separation and the arrival order did not, and they are what
    // the assertion below reads.
    const order = join(stubDir, "fifo-order");
    writeFileSync(order, "");
    const dir = stub([
      "read line",
      'id="${line%%:*}"',
      'seconds="${line#*:}"',
      `printf '%s' "$id" >> '${order}'`,
      'sleep "$seconds"',
      "printf '%s' '%PDF-1.7 ok'",
    ].join("\n"));

    await onPath(dir, async () => {
      // The holders are submitted first, so they hold every slot -- and, past the
      // cap, the front of the queue -- before any of D, E or F asks.
      const submitted = ["H:0.3", "H:0.9", "H:1.5", "D:0.1", "E:0.1", "F:0.1"];
      await Promise.all(submitted.map(async (payload) => await renderPdf(payload)));
    });

    const log = readFileSync(order, "utf8");
    expect(log).toHaveLength(6);
    // The holders' own writes race each other and are not a property; the order of
    // the three that WAITED is.
    expect(log.replace(/H/g, "")).toBe("DEF");
  }, 20_000);

  it("gives up on a slot rather than waiting forever, which is what bounds a caller's transaction", async () => {
    // WITHOUT THIS THE QUEUE WAIT IS UNBOUNDED, and the issuing transaction holds its
    // number-sequence row lock and a pooled connection across it. Ten pooled
    // connections and ten distinct years would stall every other request in the API
    // behind however many renders the cap allows. The wait is now bounded, so the lock hold is bounded by
    // the queue timeout plus the render timeout rather than by nothing.
    const dir = stub("sleep 3\nprintf '%s' '%PDF-1.7 ok'");
    await onPath(dir, async () => {
      const holding = Array.from(
        { length: RENDER_MAX_CONCURRENCY },
        async () => await renderPdf("<html></html>"),
      );
      const started = Date.now();
      const error = await renderPdf("<html></html>", { queueTimeoutMs: 200 })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RenderBusyError);
      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).message).toBe("the renderer is busy");
      expect((error as RenderError).detail).toContain("200ms");
      // It gave up on time rather than waiting out the renders ahead of it.
      expect(Date.now() - started).toBeLessThan(2000);
      await Promise.all(holding);
    });
  }, 20_000);

  it("returns a timed-out waiter's place rather than leaking the slot it never took", async () => {
    // The failure this prevents is permanent and silent: if a waiter that gave up
    // stayed in the queue, releaseRenderSlot would hand it a slot nobody is holding,
    // the in-flight count would never come back down, and the process would render
    // one fewer document at a time for the rest of its life. A full complement of
    // timeouts, then a full complement of concurrent renders must still be possible.
    const slow = stub("sleep 1\nprintf '%s' '%PDF-1.7 ok'");
    await onPath(slow, async () => {
      const holding = Array.from(
        { length: RENDER_MAX_CONCURRENCY },
        async () => await renderPdf("<html></html>"),
      );
      const abandoned = Array.from(
        { length: RENDER_MAX_CONCURRENCY },
        async () => await renderPdf("<html></html>", { queueTimeoutMs: 100 }).catch((e: unknown) => e),
      );
      for (const settled of await Promise.all(abandoned)) {
        expect(settled).toBeInstanceOf(RenderBusyError);
      }
      await Promise.all(holding);
    });

    const runDir = join(stubDir, "leak-run");
    const observed = join(stubDir, "leak-observed");
    writeFileSync(observed, "");
    const dir = concurrencyStub(runDir, observed, "0.5");
    await onPath(dir, async () => {
      await Promise.all(Array.from({ length: 3 }, async () => await renderPdf("<html></html>")));
    });
    expect(maxObserved(observed)).toBe(RENDER_MAX_CONCURRENCY);
  }, 30_000);

  it("declares the same renders manifest.toml budgets for", () => {
    // ram.runtime = 400M (Node) + RENDER_MAX_CONCURRENCY x 353MB: a render at BOTH
    // caps, in the worst SHAPE rather than the friendliest -- the markup cap full of
    // minimal table rows (250MB) with a logo at the pixel bound beside it. The
    // manifest cannot enforce anything -- YunoHost sets no cgroup from it -- so this
    // is what stops the two drifting apart in the only direction that matters: the
    // code growing a budget the declaration never heard about.
    //
    // The first version asserted against 157MB, which was a measurement of a
    // friendlier document and 2.1x too low. The second asserted 332MB, from the
    // dense-row shape at the old 128KB cap -- the right shape, and the same method
    // re-run for v1.0.1 measures it at 345MB rather than 332MB.
    const manifest = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "..", "manifest.toml"), "utf8",
    );
    const declared = /^ram\.runtime = "(\d+)M"$/m.exec(manifest);
    expect(declared?.[1]).toBeDefined();
    expect(400 + RENDER_MAX_CONCURRENCY * 353).toBeLessThanOrEqual(Number(declared?.[1]));
    expect(RENDER_MAX_CONCURRENCY).toBe(2);
    // The other half of the pair: the issuing transaction's lock hold is bounded by
    // the queue timeout plus the render timeout, and only a finite queue timeout
    // makes that sentence true.
    expect(RENDER_QUEUE_TIMEOUT_MS).toBe(10_000);
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

  // The other half of an auto-probing gate. Without these, apt failing to deliver
  // WeasyPrint -- or a noatime mount -- would turn the tests that matter into silent
  // skips and CI would stay green through it.
  it.runIf(Boolean(process.env.CI))("is installed here, because CI must prove the render", () => {
    expect(HAVE_WEASYPRINT).toBe(true);
  });

  it.runIf(Boolean(process.env.CI))("can see reads via atime here", () => {
    expect(ATIME_WORKS).toBe(true);
  });
});

// ------------------------------------------------------------- the backstop

/** Wrap bytes as a Flate-compressed PDF stream object, the way a real PDF does. */
function flateStream(content: string): Buffer {
  return Buffer.concat([
    Buffer.from("4 0 obj\n<< /Filter /FlateDecode >>\nstream\n"),
    deflateSync(Buffer.from(content)),
    Buffer.from("\nendstream\nendobj\n"),
  ]);
}

describe("pdfEmbedsFiles", () => {
  it("finds a file-spec in plain bytes", () => {
    expect(pdfEmbedsFiles(Buffer.from("%PDF-1.7\n<< /Type /Filespec /F (x) >>"))).toBe(true);
  });

  it("finds an /EF entry in plain bytes", () => {
    expect(pdfEmbedsFiles(Buffer.from("%PDF-1.7\n<< /EF << /F 5 0 R >> >>"))).toBe(true);
  });

  it("finds one inside a compressed object stream", () => {
    // 61.1 compresses by default, which is why a raw byte search once made an
    // embedded file look absent when it was very much present.
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), flateStream("<< /EF 3 0 R >>")]);

    expect(pdf.includes("/EF")).toBe(false);
    expect(pdfEmbedsFiles(pdf)).toBe(true);
  });

  it("finds one in the SECOND stream, not just the first", () => {
    // The scan used to resume one byte into "endstream", so the next search matched
    // the "stream" inside it and paired it with the FOLLOWING object's "endstream" --
    // silently skipping every other stream in the file.
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      flateStream("nothing interesting here at all"),
      flateStream("<< /Filespec 9 0 R >>"),
    ]);

    expect(pdfEmbedsFiles(pdf)).toBe(true);
  });

  it("says no to a PDF with compressed streams and no file-spec", () => {
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      flateStream("BT /F1 12 Tf (Quote QUO-2026-0001) Tj ET"),
      flateStream("<< /Type /Page /Contents 4 0 R >>"),
    ]);

    expect(pdfEmbedsFiles(pdf)).toBe(false);
  });

  it("says no to bytes that are not a PDF at all", () => {
    expect(pdfEmbedsFiles(Buffer.from("not a pdf"))).toBe(false);
    expect(pdfEmbedsFiles(Buffer.alloc(0))).toBe(false);
  });

  /**
   * A THREE-BYTE NEEDLE FIRES ON ITS OWN IN A BINARY HAYSTACK, AND THIS WAS NOT
   * HYPOTHETICAL.
   *
   * v1.0.0 searched the raw file, stream bodies included. Measuring v1.0.1's logo
   * limit produced a 287,090-byte logo whose PDF carried `/EF` inside the compressed
   * image data, and the render was refused with "rendered PDF embeds a file" -- for
   * a quote with no attachment anywhere near it. It was not a flake: the same logo
   * makes the same bytes every time, so that logo could never have been used again.
   * Raising the limit from 32KB to 300KB takes the odds of it from about 0.2% per
   * logo to about 1.7%.
   *
   * The needle can only mean something in PDF SYNTAX, so that is where it is looked
   * for. Both halves below are load-bearing in opposite directions: the first fails
   * if stream bodies are searched again, the second if the exclusion is widened from
   * "image data" to "streams".
   */
  it("does not mistake image data that happens to spell /EF for an embedded file", () => {
    const raster = Buffer.concat([
      Buffer.from("some pixels then "), Buffer.from("/EF"),
      Buffer.from(" then more pixels /Filespec and more"),
    ]);
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from("4 0 obj\n<< /Type /XObject /Subtype /Image /Filter /FlateDecode >>\nstream\n"),
      deflateSync(raster),
      Buffer.from("\nendstream\nendobj\n"),
    ]);

    expect(pdfEmbedsFiles(pdf)).toBe(false);
  });

  it("still finds a file-spec in the OBJECT of an image, and beside one", () => {
    // The dictionary is not the raster: an /EF written into an image XObject's own
    // dictionary is outside the stream body and is still found. So is one in an
    // ordinary object next to an image whose data is being skipped.
    const image = Buffer.concat([
      Buffer.from("4 0 obj\n<< /Subtype /Image /Filter /FlateDecode >>\nstream\n"),
      deflateSync(Buffer.from("raster bytes, nothing to see")),
      Buffer.from("\nendstream\nendobj\n"),
    ]);
    expect(pdfEmbedsFiles(Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      image,
      Buffer.from("5 0 obj\n<< /Type /Filespec /F (passwd) >>\nendobj\n"),
    ]))).toBe(true);

    expect(pdfEmbedsFiles(Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from("4 0 obj\n<< /Subtype /Image /EF << /F 5 0 R >> /Filter /FlateDecode >>\nstream\n"),
      deflateSync(Buffer.from("raster bytes")),
      Buffer.from("\nendstream\nendobj\n"),
    ]))).toBe(true);
  });

  it("does not let a raw stream's compressed bytes spell a needle either", () => {
    // The uncompressed half of the same trap: 57.2 does not compress object streams,
    // so on that version the deflate output of an IMAGE sits in the file as raw
    // bytes -- which is exactly where the measured false positive was found.
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from("4 0 obj\n<< /Subtype /Image >>\nstream\n"),
      Buffer.from("\xff\xd8/EF\x00\x01raw image bytes", "latin1"),
      Buffer.from("\nendstream\nendobj\n"),
    ]);

    expect(pdf.includes("/EF")).toBe(true);
    expect(pdfEmbedsFiles(pdf)).toBe(false);
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

    // Printed because the caps in documents-render.ts claim to be calibrated against
    // a real page: this line in the log is that measurement. The size is version
    // dependent (~16.8KB on 57.2, ~12.5KB on 61.1) and moves by a byte or two between
    // runs, so nothing asserts an exact figure.
    console.log(`[render] one-page quote: ${String(pdf.length)} bytes in ${String(elapsed)} ms`);

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.length).toBeLessThan(2.5 * 1024 * 1024);
    expect(elapsed).toBeLessThan(10_000);
  });

  itReal("does not mistake a legitimate branded quote for one with an attachment", () => {
    // The false-positive half of the backstop: /EF and /Filespec must be absent from
    // a real document, data: logo and all, or control 3 would refuse every render.
    return renderPdf(quoteHtml()).then((pdf) => {
      expect(pdfEmbedsFiles(pdf)).toBe(false);
    });
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

/** Feed HTML to the `weasyprint` CLI with a plain environment. Returns its stdout. */
async function bareCli(html: string): Promise<Buffer> {
  const env = { ...process.env };
  for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ftp_proxy"]) {
    delete env[key];
  }
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    const child = spawn("weasyprint", ["-", "-"], { stdio: ["pipe", "pipe", "ignore"], env });
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => { resolve(); });
    child.on("close", () => { resolve(); });
    child.stdin.on("error", () => { /* the child may not read it all */ });
    child.stdin.end(html, "utf8");
  });
  return Buffer.concat(chunks);
}

/**
 * The no-read property, tested as what it actually is: a claim about SCHEMES, and
 * asserted by whether the file was OPENED rather than by whether anything leaked.
 *
 * Two earlier versions of this suite were vacuous. The first tested http://127.0.0.1
 * alone and generalised to "fetches nothing", which is how a working file:// exfil
 * survived it. The second watched a loopback server -- but NO_NETWORK_ENV stops the
 * request before it could arrive, so a fetcher mutated to allow everything still
 * recorded zero hits and every assertion stayed green. atime sees the open itself.
 */
describe("renderPdf and the schemes it will read", () => {
  const cases: { name: string; html: (p: string) => string }[] = [
    {
      name: "file:// as an image",
      html: (p) => `<html><body><img src="file://${p}"></body></html>`,
    },
    {
      name: "file:// as a stylesheet",
      html: (p) => `<html><head><link rel="stylesheet" href="file://${p}"></head><body>x</body></html>`,
    },
    {
      name: "file:// inside an @import",
      html: (p) => `<html><head><style>@import url("file://${p}");</style></head><body>x</body></html>`,
    },
    {
      name: "file:// inside a CSS url()",
      html: (p) => `<html><body style="background-image:url('file://${p}')">x</body></html>`,
    },
    {
      name: "file:// as a <link rel=attachment>",
      html: (p) => `<html><body><link rel="attachment" href="file://${p}"></body></html>`,
    },
    {
      name: "file:// as an <a rel=attachment>, which the fetcher never sees",
      html: (p) => `<html><body><a rel="noopener attachment" href="file://${p}">x</a></body></html>`,
    },
    {
      name: "jar:file://, the exotic one",
      html: (p) => `<html><body><img src="jar:file://${p}!/x"></body></html>`,
    },
  ];

  for (const scheme of cases) {
    itReads(`refuses ${scheme.name}, and never opens the file`, async () => {
      const secret = freshSecret("mail.key");
      const error = await renderPdf(scheme.html(secret.path)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).message).toBe("document referenced a blocked resource");
      // The load-bearing assertion. A fetcher that recorded the URL and then read it
      // anyway would satisfy everything above and fail here.
      expect(statSync(secret.path).atimeMs).toBe(secret.atime);
    });
  }

  itReads("does not open a file named by a relative reference either", async () => {
    // base_url is None, so a relative URL resolves to nothing and the fetcher is
    // never reached. This is the one case that renders rather than refusing, which
    // makes checking the file itself the only way to know nothing happened.
    const secret = freshSecret("relative.key");
    const pdf = await renderPdf(`<html><body><img src="${secret.path}"></body></html>`);

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdfEmbedsFiles(pdf)).toBe(false);
    expect(statSync(secret.path).atimeMs).toBe(secret.atime);
  });

  itReal("refuses an ftp:// URL", async () => {
    const error = await renderPdf(`<html><body><img src="ftp://127.0.0.1/x.png"></body></html>`)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("document referenced a blocked resource");
  });

  itReal("refuses an http:// URL", async () => {
    const error = await renderPdf(`<html><body><img src="http://127.0.0.1:9/x.png"></body></html>`)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).message).toBe("document referenced a blocked resource");
  });

  itReal("renders a data: image, which is the one scheme a document may use", async () => {
    const pdf = await renderPdf(`<html><body><img src="${LOGO_PNG}"></body></html>`);

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  // ---- the other direction: what the bare CLI does, and why it is not used ----

  itReads("a bare CLI opens local files, which no proxy setting can prevent", async () => {
    // The finding that broke the previous design. file:// goes to urllib's
    // FileHandler and never consults a proxy, so this is exactly what the environment
    // variables cannot reach -- and it is why the renderer is invoked through its API.
    const secret = freshSecret("bare.key");
    await bareCli(`<html><body><img src="file://${secret.path}"></body></html>`);

    expect(statSync(secret.path).atimeMs).toBeGreaterThan(secret.atime);
  });

  itReal("a bare CLI embeds a local file with NO /EmbeddedFiles anywhere", async () => {
    // The payload that falsified the backstop's original needle, kept as the fixture
    // that proves the new one. `<a rel=attachment>` embeds through an annotation
    // file-spec, so the catalog's /EmbeddedFiles name tree never mentions it -- and a
    // check looking for that name called this PDF clean while the secret sat in it.
    const secret = freshSecret("annot.key");
    const pdf = await bareCli(
      `<html><body><a rel="attachment" href="file://${secret.path}">x</a></body></html>`,
    );

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.includes("/EmbeddedFiles")).toBe(false);
    expect(pdfEmbedsFiles(pdf)).toBe(true);
  });
});
