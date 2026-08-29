# Conduit Phase 7 — Documents (quotes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise a numbered, branded PDF quote from a deal, stored on that deal's record, which never changes once issued.

**Architecture:** Five new tables (migration 0009). All money arithmetic is integer-only and lives in `packages/shared` so the form's running total and the stored total are computed by the same code. Rendering shells out to the WeasyPrint binary with merged HTML on stdin and PDF on stdout, inside the same transaction that allocates the number — so a failed render spends nothing.

**Tech Stack:** Fastify 5, Drizzle ORM (postgres.js), React 19 / TanStack Query, Tailwind v4, `sanitize-html`, WeasyPrint (apt), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-28-conduit-phase-7-documents-design.md` — it is the authority. Read it before Task 1.

**Baseline at start:** 1829 unit + 36 integration skipped + 96 e2e, green. Branch `worktree-phase-7-documents` from `ee27322`.

---

## Conventions every task must follow

These are the house rules this repo has accumulated. Violating one is how the last six
phases produced their review findings.

- **Migrations are generated, never hand-written and never pushed.** `npx drizzle-kit generate` after editing `packages/api/src/db/schema.ts`. **NEVER run `drizzle-kit push`.** A shipped migration is never touched.
- **Revising an UNSHIPPED migration: regenerate it, do not hand-edit it.** Earlier phases hand-edited the SQL and then hand-edited the snapshot to match. Task 2 established that regenerating is both safer and less work — drizzle writes the snapshot itself, so a 4,000-line JSON file cannot drift from the SQL — provided you then restore the journal's original `when` and `tag` so the filename and ordering do not move. Verify the journal diff is empty afterwards.
- **After revising an unshipped migration, `conduit_test` must be DROPPED and recreated.** The migrator skips by timestamp, so an already-applied 0009 is never re-applied no matter what its contents now say, and your tests will run against the old shape while the file on disk says something else. This is the failure mode that makes a hand-edited migration look like it worked.
- **Server work goes through the dev checkout:** `CONDUIT_REMOTE_DIR=/home/chris/conduit-phase4 ./scripts/remote.sh '<cmd>'`. Pass that variable **explicitly on every call** — the default points at a different checkout and a previous session overwrote it.
- **Vitest runs from the repo root.** The root global setup migrates Postgres before any project's tests, so the suite needs a database.
- **ASCII only** in source and tests. **Targeted `git add`** — never `git add -A`.
- **`drizzle-kit generate` splits statements on a bare `;` — INCLUDING one inside a string literal.** Task 4 wrote a CHECK containing a regex with a `;` in it and got a migration truncated mid-expression, which is a broken migration that looks like a written one. Escape it (`\073`) or keep semicolons out of CHECK expressions entirely, and **read every generated migration end to end** rather than only checking that it creates what you expected.
- **A version-specific REPRESENTATION is not a property, and this has now cost two CI rounds in two different tasks.** WeasyPrint 61.1 (CI) compresses PDF object streams; 57.2 (the server) does not. So a raw byte scan for `/EmbeddedFiles` finds it on one and not the other, and a page tree that is plain text on one is invisible on the other. Task 1 hit it, recorded it, and Task 2 read that record and walked into the same trap anyway. **Assert the property, never the encoding**: inflate every Flate stream before scanning, or better, build a fixture that exhibits the mechanism and needs no renderer at all — Task 2's hand-built PDF whose page tree exists only inside a compressed object stream pins the reader on every machine, at any version.
- **Comments must be true.** Three commits in Phase 6 existed only to correct comments that read utility names as pixel counts or claimed memoisation that did not hold. If you write a number in a comment, measure it.
- Conventional commits, signed `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File structure

| File | Responsibility |
|---|---|
| `packages/shared/src/money.ts` | Integer-only line/tax/total arithmetic. Pure. Used by BOTH api and web. |
| `packages/shared/src/money.test.ts` | Exhaustive arithmetic tests including the half-cent boundary. |
| `packages/api/src/db/schema.ts` | The five new tables (modify). |
| `packages/api/src/services/documents-render.ts` | The WeasyPrint subprocess. Nothing else. |
| `packages/api/src/services/documents-template.ts` | The sanitiser profile and merge-field resolution. Pure. |
| `packages/api/src/services/documents-number.ts` | Number allocation and formatting. |
| `packages/api/src/services/documents.ts` | The one transactional `issueQuote` orchestration. |
| `packages/api/src/services/org-profile.ts` | The issuer singleton. |
| `packages/api/src/routes/documents.ts` | HTTP surface. |
| `packages/web/src/pages/deal-detail.tsx` | Documents section + New quote (modify). |
| `packages/web/src/components/document-form.tsx` | The line-item editor. Phone-first. |
| `packages/web/src/pages/settings-org.tsx` | Issuer profile + logo. |
| `packages/web/src/pages/settings-templates.tsx` | Add the document template editor (modify). |
| `e2e/documents.spec.ts` | The journey, desktop and phone. |

---

### Task 1: The packaging gate — prove WeasyPrint on the real server FIRST

**Why this is Task 1:** every other task depends on a binary that is not installed
anywhere yet, on a server whose package set you do not control. Discovering on day six
that it will not run is the expensive version of this task. **Report your findings
before writing any feature code**; if the binary cannot be made to work, that reshapes
the phase and is a coordinator decision, not something to work around.

**Files:**
- Create: `packages/api/src/services/documents-render.ts`
- Create: `packages/api/src/services/documents-render.test.ts`
- Modify: `manifest.toml` (the apt resource)
- Modify: `.github/workflows/test.yml` (install the binary in CI)

- [ ] **Step 1: Establish what the server actually has**

```bash
CONDUIT_REMOTE_DIR=/home/chris/conduit-phase4 ./scripts/remote.sh 'which weasyprint || echo ABSENT; python3 --version; apt-cache policy weasyprint | head -5'
```

Record the exact output in your report. Debian's `weasyprint` package name and version
vary by release; do not assume.

- [ ] **Step 2: Write the failing test**

`packages/api/src/services/documents-render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderPdf, RenderError, weasyprintAvailable } from "./documents-render.ts";

const itRender = (await weasyprintAvailable()) ? it : it.skip;

describe("renderPdf", () => {
  itRender("returns a PDF for ordinary HTML", async () => {
    const pdf = await renderPdf("<html><body><h1>Quote</h1></body></html>");
    // %PDF- is the format's magic number; every conforming file starts with it.
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(500);
  });

  itRender("rejects HTML that would take longer than the timeout", async () => {
    await expect(renderPdf("<html><body>x</body></html>", { timeoutMs: 1 }))
      .rejects.toBeInstanceOf(RenderError);
  });

  it("reports availability without throwing when the binary is absent", async () => {
    await expect(weasyprintAvailable()).resolves.toBeTypeOf("boolean");
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run packages/api/src/services/documents-render.test.ts`
Expected: FAIL — `Failed to resolve import "./documents-render.ts"`.

- [ ] **Step 4: Implement the subprocess**

`packages/api/src/services/documents-render.ts`:

```ts
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

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * WeasyPrint reads HTML from stdin and writes PDF to stdout when both paths are "-".
 *
 * `--base-url` is deliberately NOT set. Without it a relative or remote URL in the
 * document has nothing to resolve against, which is the belt to the sanitiser's
 * braces: documents-template.ts strips remote URLs on the way in, and this makes a
 * survivor unresolvable rather than fetched. Rendering therefore touches no network,
 * which is what lets an untrusted-ish HTML input be safe to render at all.
 */
export async function renderPdf(html: string, options: RenderOptions = {}): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("weasyprint", ["-", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (message: string, detail = ""): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new RenderError(message, detail));
    };

    const timer = setTimeout(() => fail("render timed out"), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { fail("render exceeded the size cap"); return; }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { err.push(chunk); });
    child.on("error", (e) => { clearTimeout(timer); fail("could not start weasyprint", e.message); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) { reject(new RenderError(`weasyprint exited ${String(code)}`, Buffer.concat(err).toString("utf8").slice(0, 2000))); return; }
      resolve(Buffer.concat(out));
    });

    child.stdin.on("error", () => { /* closed early; `close` reports the real reason */ });
    child.stdin.end(html, "utf8");
  });
}

/** Whether the binary is present. Never throws -- the tests gate on it. */
export async function weasyprintAvailable(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("weasyprint", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
```

- [ ] **Step 5: Run it locally, then on the server**

Run: `npx vitest run packages/api/src/services/documents-render.test.ts`
Expected locally: PASS with the two render tests SKIPPED if you have no binary.

Then install it on the server and prove a real PDF:

```bash
CONDUIT_REMOTE_DIR=/home/chris/conduit-phase4 ./scripts/remote.sh 'cd /home/chris/conduit-phase4 && npx vitest run packages/api/src/services/documents-render.test.ts'
```

Expected on the server: the render tests SKIP cleanly while the stub-driven failure-path
tests still run. **If the binary is absent there, say so and stop for a ruling** — you
may not `sudo apt install`; Chris holds sudo deliberately.

- [ ] **Step 6: Declare the dependency in the manifest**

`manifest.toml` ALREADY HAS a `[resources.apt]` block (`packages = "postgresql"`). A
second one is a duplicate-key TOML error. **Edit the existing line**, and name munkres
first — see the spec's Context for the 508MB vs 89MB measurement:

```toml
packages = "postgresql, python3-munkres, weasyprint"
```

Verify you have not broken the manifest: `python3 -c "import tomllib,pathlib; tomllib.loads(pathlib.Path('manifest.toml').read_text()); print('manifest parses')"`

- [ ] **Step 7: Install it in CI so the render tests actually run there**

`.github/workflows/test.yml`, in the `test` job before `npm ci`:

```yaml
      - name: Install WeasyPrint
        run: sudo apt-get update && sudo apt-get install -y weasyprint
```

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/services/documents-render.ts packages/api/src/services/documents-render.test.ts manifest.toml .github/workflows/test.yml
git commit -m "feat(api,packaging): render HTML to PDF through WeasyPrint, and declare it"
```

- [ ] **Step 9: Report before continuing**

State: the server's binary name and version; whether the render tests passed there; the
CI run id proving they pass on Ubuntu; and anything about the apt package that surprised
you. Do not start Task 2 until this is reported.

#### TASK 1 DONE — and four things in the steps above are now WRONG

Commits `bb5880c`, `3b95519`. CI run **33191112378**, tip `3b95519`, both jobs green:
52 files, **1881 tests, 0 skipped** (CI installs the binary). On the server: 1839 passed
/ 42 skipped.

Read these before trusting the code above; the steps are left as written so the
correction is legible rather than silently patched.

1. **Step 4 spawns the WRONG PROGRAM, and this took two rounds to get right.** The
   `--base-url` comment is false: a base URL governs only what RELATIVE references
   resolve against, and an absolute `http://` URL needs no base and is fetched — proved
   with a loopback server that records requests. But the first fix, pointing the child's
   proxy variables at a closed port, was **also insufficient, and a spec reviewer broke
   it with a working exploit on the server**: `file://` never consults a proxy.
   `default_url_fetcher` hands every absolute URI to `urllib.urlopen`, whose opener
   carries `FileHandler`, and 57.2's fetcher has an explicit `file://` branch before it.
   WeasyPrint embeds `<link rel=attachment>` targets into `/EmbeddedFiles`, so under the
   shipped proxy settings `<link rel="attachment" href="file:///etc/passwd">` exited 0
   and the file came back out of the PDF byte for byte. On a deployment that is
   `$DATA_DIR/mail.key` (`config.ts:81`, created 600 `conduit:conduit` by
   `scripts/install:33-35`, readable by the user the API runs as) and with it every
   stored IMAP and SMTP password — reachable by putting one line in a template, raising
   a quote and downloading it through Task 4's ordinary `GET /api/files/:id`.

   **The CLI cannot be made safe: it has no flag to restrict schemes.** The shipped code
   therefore spawns `python3 -c` with WeasyPrint's API and a `url_fetcher` that
   allowlists `data:` and raises on everything else, and a blocked URL FAILS the render
   rather than degrading quietly. The proxy variables stay as a cheap second barrier and
   are documented as not being the control. Verified per scheme on 57.2 and 61.1:
   `file://` through `link rel=attachment`, `img` and `stylesheet`; `http://` (watched on
   the loopback server); `ftp://`; `jar:`. A relative reference still renders without the
   asset, because `base_url=None` means the fetcher is never reached at all.

   **The fetcher alone was STILL not enough, and a red CI run is what said so.** On
   61.1 the attachment case rendered happily with the secret inside it. The reason,
   established by a diagnostic run on the runner rather than guessed:
   `Attachment.__init__` binds `url_fetcher=default_url_fetcher` **as a default
   argument**, so the fetcher passed to `HTML(...)` never reaches an attachment — the
   diagnostic printed `FETCHER-CALLS []` alongside the file's contents in the output.
   57.2 does route attachments through the document's fetcher, so 57.2 was covered by
   accident. (The first red run also misled: `/EmbeddedFiles` looked absent on 61.1
   only because it compresses object streams, so a raw byte search missed it. Search
   inflated streams, or render with `uncompressed_pdf=True`, before concluding.)

   **So the renderer has three controls.** (1) the `data:`-only fetcher; (2)
   `rel=attachment` refused outright, upstream of whichever fetcher a version uses, and
   covering `<a rel=attachment>` as well as `<link>`; (3) `pdfEmbedsFiles`, on the bytes
   that come back.

   **Control 3's needle was WRONG, and a quality reviewer found it.** It looked for
   `/EmbeddedFiles`, which `<link rel=attachment>` registers in the catalog's name tree
   — but `<a rel=attachment>` embeds through an ANNOTATION file-spec that never appears
   there, so the check called that PDF clean with the secret sitting in it. The needle
   is now `/EF` or `/Filespec`, present for both routes and absent from a branded quote
   with or without a `data:` logo. **Proved on 61.1** by pushing a temporary mutation
   with control 2 removed (CI run `33203020172`): both attachment payloads were caught
   by control 3, failing with `rendered PDF embeds a file`.

   **Control 3 also MOVED from the Python into TypeScript**, and that is the structural
   lesson: as a Python function it was reachable only through a subprocess behind two
   controls that short-circuit first, so nothing ever fed it the payload that would have
   exposed the bad needle. As an exported `pdfEmbedsFiles(pdf: Buffer)` it has six unit
   tests over plain bytes — including one for the second-stream scan bug, and one using
   the bare CLI to produce a real annotation-route PDF.

   **The lesson worth carrying into Task 3:** the previous suite tested exactly one
   scheme and generalised to "fetches nothing". Anything asserting a no-network or
   no-read property must be parametrised over schemes, asserted as a property (the
   mechanism moves between versions), and **checked against a mutant** — three of this
   task's assertions turned out to prove nothing at all until that was done.
2. **Step 4's `renderPdf` resolved a zero-byte "PDF".** A child that exits 0 having
   written nothing returned `Buffer.concat([])`, which would have put an empty file in a
   deal's Files with no error raised anywhere. The shipped version treats a stdout that
   does not begin `%PDF-` as a failed render. Its `fail()` also clears its own timeout
   rather than relying on the `close` event — the one event a timeout exists to survive
   the absence of.
3. **Step 2's test file would have skipped every failure path** on any machine without
   the binary, which is backwards for code whose whole job is failing well. The shipped
   tests are in three parts: **nine** stub-driven tests shadow `python3` on `PATH` and
   run EVERYWHERE; six unit tests drive `pdfEmbedsFiles` over plain bytes; the rest are
   gated on the binary.

   **THREE of those assertions were vacuous, and only mutation testing said so.**
   (a) `expect(hits).toEqual([])` against a loopback server proved nothing, because
   `NO_NETWORK_ENV` stops the request before it could arrive — a fetcher mutated to
   record the URL and then read it anyway stayed green. The suite now watches **atime**,
   which sees an `open` by any code path; a fresh file is backdated a day first, so
   `relatime` is guaranteed to report the read and the delta is a day rather than a
   rounding error. Re-running that mutation now fails three tests. (b) The kill
   assertion checked its marker at ~1s against a 3s sleep, so the marker was absent
   either way and deleting `child.kill("SIGKILL")` left four tests green; the sleep is
   now 700ms and the check at 1200ms, **after** it would have fired, and the mutation
   now fails. (c) A carve-out in the fetcher's allowlist also went undetected; atime
   catches those too.
4. **The gate is NOT the MAIL_IT pattern the spec names.** `MAIL_IT` is an explicit
   opt-in, so a broken fixture fails loudly; this one probes, so a packaging change that
   stopped delivering WeasyPrint would turn the real half into silent skips with CI still
   green. A `runIf(process.env.CI)` test asserts the binary is present whenever CI runs.
5. **Import specifiers are `.js`, not `.ts`** — NodeNext, and the repo convention.

**Measured, and the first two attempts at these numbers were both wrong.** All figures
from the server (Debian 12, WeasyPrint 57.2) running the SHIPPED script, against the
exact document the test file renders. The one-page quote (A4, `@page` margins, a running
footer, a `data:` logo, 8 line items, totals, terms) is **0.6s to 16,776 bytes at 66.5MB
peak RSS** — an earlier draft said 14,002 bytes because it measured a different, simpler
document, and the test's own log on the server had been printing ~16,772 the whole time.
On CI's 61.1 the same page is ~12,460 bytes.

**Cost is set by the SHAPE of the document, not just its size**, which is why an earlier
draft's 435KB figure was 2x low: it used repeated prose, and a quote is a table.

| input | table-shaped | prose |
|---|---|---|
| 32 KB | 1.6s / 87MB | — |
| 64 KB | 2.8s / 110MB | — |
| **128 KB** | **5.2s / 157MB** | — |
| 256 KB | 9.8s / 251MB | — |
| 1 MB | 39.7s / 816MB | — |
| 2 MB | 86.5s / 1565MB | 15.9s / 245MB |

- The **128KB input cap** is what actually bounds a render, and it replaced a 2MB one
  that was unsafe. **The timeout cannot bound memory, because the expensive documents
  are the ones fast enough to survive it**: at 2MB, a 256KB table finishes in 9.8s —
  well inside the 20s ceiling — and costs 251MB. The cap holds a render to ~157MB.
- **A logo above ~64KB will not fit**, since it arrives inlined as a `data:` URI at 4/3
  of its stored size. **Task 5's upload has to bound it**, or the failure is a quote
  that cannot be raised.
- The **20s timeout** is ~30x the one-page render and bounds how long Task 4's
  transaction holds its row lock, so it should not grow.
- The **25MB output cap** is not tuned; it bounds what is accumulated in memory from a
  runaway stream.
- `ram.runtime` went 400M -> **900M** = 400M (Node) + 3 x 157MB. **See Task 4's own
  section for the concurrency limit this depends on** — it is recorded there rather than
  only here, because that is where it gets implemented.

**The render is NOT reproducible, and Task 4 must not assume it is.** Three runs of the
identical input on the identical version gave 6899, 6899 and **6898** bytes. The
immutability test must therefore compare the STORED bytes across the edits it makes — it
must never re-render and diff, which would fail for reasons that have nothing to do with
immutability.

**Reproducing the apt figures** (the count line sits ~138 lines above the tail, and a
non-root `-s` run prints no size summary at all, so grep for it):

```bash
CONDUIT_REMOTE_DIR=/home/chris/conduit-phase4 ./scripts/remote.sh \
  'apt-get -s install weasyprint | grep "upgraded,"; apt-get -s install python3-munkres weasyprint | grep "upgraded,"'
```

**Open, for Task 6 and the release.** CI proves the path on WeasyPrint **61.1** (Ubuntu
24.04); the server will run **57.2** (Debian 12 bookworm) and nothing has yet rendered a
byte on 57.2. Both are post-53 (pydyf + Pango, no cairo), so there is no architectural
difference, but the gap is unclosed until Chris installs and the render tests are run
there. **The `e2e` CI job does not install WeasyPrint** — Task 6's journey spec needs
that step added or it will fail on a runner with no binary.

---

### Task 2: The arithmetic, and the schema it is stored in

**Files:**
- Create: `packages/shared/src/money.ts`, `packages/shared/src/money.test.ts`
- Modify: `packages/api/src/db/schema.ts`
- Create: `packages/api/drizzle/0009_*.sql` (generated)

**The arithmetic is integer-only.** Quantities are thousandths (`qtyMilli`), prices are
cents, tax rates are basis points. No floating point appears anywhere in a money path,
which is what makes the totals reproducible rather than nearly right.

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/money.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { lineTotalCents, taxCents, documentTotals } from "./money.ts";

describe("lineTotalCents", () => {
  it("multiplies a whole quantity by a unit price", () => {
    expect(lineTotalCents({ qtyMilli: 3000, unitPriceCents: 1250 })).toBe(3750);
  });

  it("handles a fractional quantity", () => {
    expect(lineTotalCents({ qtyMilli: 1500, unitPriceCents: 1000 })).toBe(1500);
  });

  // The half-cent boundary is the entire reason this function exists rather than
  // being written inline at three call sites with three different roundings.
  it("rounds a half cent UP, not to even", () => {
    // 0.5 x 1 cent = 0.5 cents exactly.
    expect(lineTotalCents({ qtyMilli: 500, unitPriceCents: 1 })).toBe(1);
  });

  it("rounds below the half cent DOWN", () => {
    expect(lineTotalCents({ qtyMilli: 499, unitPriceCents: 1 })).toBe(0);
  });
});

describe("taxCents", () => {
  it("applies a basis-point rate to a line total", () => {
    expect(taxCents(10_000, 2100)).toBe(2100);
  });

  it("rounds half up", () => {
    // 1 cent at 50% = 0.5 cents.
    expect(taxCents(1, 5000)).toBe(1);
  });

  it("returns zero for a zero rate", () => {
    expect(taxCents(9999, 0)).toBe(0);
  });
});

describe("documentTotals", () => {
  it("sums line totals and per-line tax", () => {
    const totals = documentTotals([
      { qtyMilli: 2000, unitPriceCents: 5000, taxRateBp: 2100 },
      { qtyMilli: 1000, unitPriceCents: 1000, taxRateBp: 0 },
    ]);
    expect(totals).toEqual({ subtotalCents: 11_000, taxCents: 2100, totalCents: 13_100 });
  });

  // Tax per line then summed, NOT tax on the summed subtotal. These differ by a cent
  // on exactly this input, and the difference is what an accountant notices.
  it("taxes each line rather than the subtotal", () => {
    const lines = [
      { qtyMilli: 1000, unitPriceCents: 5, taxRateBp: 5000 },
      { qtyMilli: 1000, unitPriceCents: 5, taxRateBp: 5000 },
    ];
    // Per line: round(2.5) = 3 each, so 6. On the subtotal: round(5) = 5.
    expect(documentTotals(lines).taxCents).toBe(6);
  });

  it("returns zeroes for no lines", () => {
    expect(documentTotals([])).toEqual({ subtotalCents: 0, taxCents: 0, totalCents: 0 });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/shared/src/money.test.ts`
Expected: FAIL — cannot resolve `./money.ts`.

- [ ] **Step 3: Implement**

`packages/shared/src/money.ts`:

```ts
/**
 * Money arithmetic for documents. Integer-only, on purpose: a quote's total is
 * printed, stored and shown in three places, and they must agree exactly.
 *
 * UNITS. Quantities are THOUSANDTHS (qtyMilli: 1500 is 1.5). Prices are CENTS. Tax
 * rates are BASIS POINTS (2100 is 21%). Nothing here takes a float, so nothing here
 * can drift.
 *
 * Both api and web import this. The form's running total and the stored total are
 * therefore the same function, not two implementations that agree until they do not.
 */

export interface LineInput {
  qtyMilli: number;
  unitPriceCents: number;
  taxRateBp?: number;
}

export interface DocumentTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * Divide by `divisor` rounding half AWAY FROM ZERO. Quantities and prices are
 * constrained non-negative by CHECK constraints, so this is half-up in practice;
 * the negative branch exists so a future credit note cannot silently round the
 * wrong way.
 */
function divideRoundHalfUp(value: number, divisor: number): number {
  const half = Math.trunc(divisor / 2);
  return value >= 0
    ? Math.trunc((value + half) / divisor)
    : -Math.trunc((-value + half) / divisor);
}

export function lineTotalCents(line: LineInput): number {
  return divideRoundHalfUp(line.qtyMilli * line.unitPriceCents, 1000);
}

export function taxCents(lineTotal: number, rateBp: number): number {
  return divideRoundHalfUp(lineTotal * rateBp, 10_000);
}

export function documentTotals(lines: readonly LineInput[]): DocumentTotals {
  let subtotalCents = 0;
  let tax = 0;
  for (const line of lines) {
    const total = lineTotalCents(line);
    subtotalCents += total;
    tax += taxCents(total, line.taxRateBp ?? 0);
  }
  return { subtotalCents, taxCents: tax, totalCents: subtotalCents + tax };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run packages/shared/src/money.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Add the tables to the schema**

`packages/api/src/db/schema.ts`, appended after the meetings block:

```ts
// --- Documents (Phase 7) -------------------------------------------------

// The issuer: YOUR company, as printed at the top of a quote. A singleton --
// `singleton` is a CHECK-pinned constant so a second row cannot exist, which is
// simpler to reason about than a settings key/value table for six known fields.
export const orgProfile = pgTable("org_profile", {
  id: uuid("id").primaryKey().defaultRandom(),
  singleton: boolean("singleton").notNull().default(true),
  name: text("name").notNull().default(""),
  addressLines: text("address_lines").notNull().default(""),
  vatNumber: text("vat_number").notNull().default(""),
  registrationNumber: text("registration_number").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  website: text("website").notNull().default(""),
  bankDetails: text("bank_details").notNull().default(""),
  logoFileId: uuid("logo_file_id").references(() => files.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("org_profile_singleton").on(t.singleton),
  check("org_profile_singleton_true", sql`singleton IS TRUE`),
]);
export type OrgProfileRow = typeof orgProfile.$inferSelect;

// An ISSUED document. There is no draft state: a row here means a PDF exists.
//
// The recipient is SNAPSHOT, not joined: `recipient_name`/`recipient_address` are
// copied at issue. A company that is renamed or moves office afterwards does not
// rewrite a quote somebody already has in their inbox.
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: text("number").notNull(),
  type: text("type").notNull(),
  dealId: uuid("deal_id").notNull().references(() => deals.id),
  fileId: uuid("file_id").notNull().references(() => files.id),
  currency: char("currency", { length: 3 }).notNull(),
  issueDate: date("issue_date").notNull(),
  validUntilDate: date("valid_until_date"),
  recipientName: text("recipient_name").notNull(),
  recipientAddress: text("recipient_address").notNull().default(""),
  subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull(),
  taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
  totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  notes: text("notes").notNull().default(""),
  terms: text("terms").notNull().default(""),
  issuedByUserId: uuid("issued_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("documents_number_unique").on(t.number),
  check("documents_type_valid", sql`type IN ('quote')`),
  index("documents_deal_idx").on(t.dealId),
]);
export type DocumentRow = typeof documents.$inferSelect;

// Frozen at issue, in the units packages/shared/src/money.ts defines: quantity in
// THOUSANDTHS, price in CENTS, tax in BASIS POINTS. The stored line_total_cents is
// what was printed -- it is not recomputed on read, so a change to the arithmetic
// can never restate an issued document.
export const documentLineItems = pgTable("document_line_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  description: text("description").notNull(),
  qtyMilli: integer("qty_milli").notNull(),
  unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
  taxRateBp: integer("tax_rate_bp").notNull().default(0),
  lineTotalCents: bigint("line_total_cents", { mode: "number" }).notNull(),
}, (t) => [
  uniqueIndex("document_line_items_position").on(t.documentId, t.position),
  check("document_line_items_qty_nonneg", sql`qty_milli >= 0`),
  check("document_line_items_price_nonneg", sql`unit_price_cents >= 0`),
  check("document_line_items_tax_range", sql`tax_rate_bp BETWEEN 0 AND 10000`),
]);
export type DocumentLineItemRow = typeof documentLineItems.$inferSelect;

// A TABLE, not a Postgres SEQUENCE, and the difference is the point: nextval() is
// non-transactional, so a render that failed after taking a number would leave a
// permanent hole in the quote sequence. A row rolls back with its transaction.
export const documentNumberSequences = pgTable("document_number_sequences", {
  type: text("type").notNull(),
  year: integer("year").notNull(),
  lastValue: integer("last_value").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.type, t.year] })]);

export const documentTemplates = pgTable("document_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),
  bodyHtml: text("body_html").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("document_templates_type").on(t.type)]);
export type DocumentTemplateRow = typeof documentTemplates.$inferSelect;
```

Add `boolean`, `index`, `primaryKey` and `uniqueIndex` to the `drizzle-orm/pg-core`
import at the top of the file if they are not already there.

- [ ] **Step 6: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new `packages/api/drizzle/0009_*.sql`. **Read it before continuing** and
confirm it creates five tables and no `DROP`. If it wants to drop anything, stop — your
schema edit diverged from the existing tables.

- [ ] **Step 7: Seed the default template inside that migration**

Append to the generated `0009_*.sql` (an unshipped migration may be edited in place):

```sql
INSERT INTO "document_templates" ("type", "body_html") VALUES ('quote', '<style>@page { size: A4; margin: 20mm; } body { font-family: sans-serif; font-size: 11pt; color: #111; } h1 { font-size: 18pt; margin: 0 0 4mm; } table { width: 100%; border-collapse: collapse; margin-top: 8mm; } th, td { text-align: left; padding: 2mm 0; border-bottom: 0.2mm solid #ccc; } td.num, th.num { text-align: right; } .totals { margin-top: 6mm; width: 100%; } .totals td { border: none; } .muted { color: #666; }</style><h1>Quote {{document.number}}</h1><p class="muted">{{document.issueDate}}</p><p><strong>{{org.name}}</strong><br>{{org.addressLines}}<br>{{org.email}}</p><p><strong>To</strong><br>{{document.recipientName}}<br>{{document.recipientAddress}}</p><table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th></tr></thead><tbody>{{#lines}}<tr><td>{{description}}</td><td class="num">{{qty}}</td><td class="num">{{unitPrice}}</td><td class="num">{{lineTotal}}</td></tr>{{/lines}}</tbody></table><table class="totals"><tr><td>Subtotal</td><td class="num">{{document.subtotal}}</td></tr><tr><td>Tax</td><td class="num">{{document.tax}}</td></tr><tr><td><strong>Total</strong></td><td class="num"><strong>{{document.total}}</strong></td></tr></table><p>{{document.notes}}</p><p class="muted">{{document.terms}}</p>');
```

- [ ] **Step 8: Apply and verify**

Run: `npx vitest run packages/api/src/db/schema.test.ts`
Expected: PASS — the global setup applies 0009 to `conduit_test`.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/money.ts packages/shared/src/money.test.ts packages/api/src/db/schema.ts packages/api/drizzle
git commit -m "feat(shared,api): integer money arithmetic, and the tables a quote is stored in"
```

#### TASK 2 DONE — seven divergences, and three things Tasks 3-5 must honour

Commit `b017173`. CI run **33206274811**, tip `b017173`, both jobs green: **1930 tests,
0 skipped**. On the server: 1892 passed / 38 skipped. Migration is
`packages/api/drizzle/0009_calm_rhodey.sql`; it creates five tables, drops nothing, and
alters nothing existing.

The steps above are left as written so the corrections are legible.

1. **`packages/shared` needed one line, and it is not the one Step 3 implies.** The
   package's `exports` map has `"."` and nothing else, so a sibling module is invisible
   to api and web until `index.ts` re-exports it -- `fractional.js`'s `export { midpoint }`
   is the precedent and the only route there is. No `package.json` or tsconfig change.
   Vitest aliases `@conduit/shared` to `src/index.ts`, but **web does not**: it resolves
   through `dist`, so the barrel is what Task 5 will actually import. Verified by
   importing the BUILT package on the server (`packages/shared/dist/money.js` exists,
   `documentTotals` resolves and computes), not by reading the config.

2. **The arithmetic is BigInt internally, and the plan's version is wrong by a cent.**
   `Math.trunc((qtyMilli * unitPriceCents + 500) / 1000)` forms the product in double
   precision, and the product leaves the safe range long before either factor does: at
   `qtyMilli` 3603500 and `unitPriceCents` 9999999903 it returns 36034999650460 for an
   exact 36034999650461. Every input and every result is also checked to be a safe
   integer and a violation THROWS -- load-bearing rather than defensive, because the
   totals land in `bigint` columns read through drizzle's `mode: "number"`, whose range
   stops at 2^53 while Postgres's stops at 2^63, so an unchecked total would be stored
   as the nearest double and accepted silently.

   **THE MUTATION COUNTS, RE-MEASURED, because the first note gave one that does not
   reproduce.** It said "fails exactly four of the nineteen tests", which was the
   result of a PARTIAL mutation -- only `lineTotalCents` replaced by the plan's
   unguarded double version, with `taxCents` and `documentTotals` still guarded --
   against the 19-test file of that round. Against the 23-test file this round, all
   three variants measured on the server:

   | mutation | fails |
   |---|---|
   | the plan's Step 3 verbatim (double divide, NO guards) | **9 of 23** |
   | the divide alone in double precision, both guards retained | **1 of 23** |
   | `lineTotalCents` alone, unguarded (the first round's mutation) | 6 of 23 |

   The one that fails under the divide-only mutation is "is exact when the
   intermediate product passes 2^53", which is the assertion the BigInt rewrite
   exists for; the other eight under the verbatim mutation are the guards.

   **THE CONTRACT THIS PUTS ON TASK 5:** the form must parse its text into integer units
   and reject what does not parse BEFORE calling `documentTotals`. A half-typed field is
   a validation error to show, not a total to render -- `documentTotals` throws on NaN
   rather than rendering `NaN` into a running total.

3. **`uniqueIndex` and `index` are not used, and Step 5's import instruction is wrong on
   all four counts.** `boolean` and `primaryKey` were already imported; `index` and
   `uniqueIndex` are imported by nothing in this file and used by no table in the
   codebase. This schema declares unique CONSTRAINTS (`unique("name").on(...)`, the
   mail block's pattern) and hand-writes plain indexes in the migration (0004's header,
   0008's five). Both conventions are followed; `documents_deal_idx` is the one
   hand-written index, and the drill asserts it from a from-the-files migration because
   it exists in no drizzle snapshot.

4. **`org_profile` is a pinned integer primary key plus one CHECK.** The plan's
   boolean-column-plus-unique-index-plus-CHECK does enforce one row -- but with four
   moving parts where two suffice, and it leaves a `defaultRandom()` uuid nobody can
   predict, so every reader must find the row before updating it and the upsert has to
   conflict on a NON-KEY column. Pinned at 1: read is `WHERE id = 1`, create-or-update
   is `ON CONFLICT (id) DO UPDATE`. Both halves are tested and both were mutation-checked
   (dropping the CHECK fails the test); the PK stops a second row at id 1, the CHECK
   stops one at any other id. The only non-uuid key in the file, and that is the point:
   a uuid is for a row you will have many of.

5. **`documents.number` stays globally unique, and it forbids nothing.** Numbering is per
   `(type, year)` but the formatted string already contains both, so two numbers can only
   collide if two types share a prefix -- and if a future type ever were given a colliding
   prefix, a global unique rejects the second document loudly at issue instead of minting
   a duplicate. It also matches how a number is used: nobody quoting "QUO-2026-0001" back
   at you says which column it came from.

6. **`document_line_items.position` is an INTEGER, and that is the right answer here.**
   Fractional `positionText` exists so a drag-and-drop reorder writes one row instead of
   renumbering siblings, and it buys that with a `COLLATE "C"` pin and unbounded key
   growth. Line items are inserted once inside the issuing transaction and never
   reordered -- there is no drag to optimise -- so 1..n is denser, directly meaningful
   ("line 3") and needs no collation. The UNIQUE on `(document_id, position)` is what
   makes the ordering total, and it doubles as the FK index.

7. **Four constraints the plan did not have**, all house-style consistency rather than
   invention: `documents_currency_format` (deals has the identical CHECK, and a document
   copies its deal's currency), `documents_totals_consistent`
   (`total = subtotal + tax`, the backstop for the exact defect the spec names as this
   feature's classic one -- mutation-checked), and the `type IN ('quote')` CHECK repeated
   on `document_number_sequences` and `document_templates` (a typo'd type would otherwise
   start a private numbering series in silence). **No `ON DELETE CASCADE` on line items**:
   there is not one `onDelete` clause anywhere in this schema, a document is never
   deleted, and NO ACTION means a stray DELETE fails loudly rather than quietly taking
   the priced lines of an issued quote with it.

8. **`documents` grows `recipient_contact_name`.** The spec's column list says "name and
   address as text", but the same spec has the form default its recipient from the deal's
   company AND contact, and a quote prints both ("Acme Ltd, FAO Jane Smith"). With two
   columns the contact has to be smuggled into one of them and the row stops recording
   what was on the page. Checked against a real `companies` row while doing it:
   **`companies` carries no VAT or registration number at all**, so a document cannot
   snapshot the RECIPIENT's VAT number. Harmless for a quote; it is a blocker for the
   invoice type the spec defers, and that is where it should be solved.

**THE SEEDED TEMPLATE WAS RENDERED BEFORE IT WAS COMMITTED**, on the server against
WeasyPrint 57.2 through the shipped `renderPdf`, and again after the review round added
the tax column: merged with a filled org profile and 8 line items at mixed 21%/9% rates
it is 4,090 bytes of HTML and a **16,493-byte two-page PDF**; merged with an entirely
empty context it still renders (10,106 bytes). The running footer reads "Page 1 of 2",
the newline-separated addresses break across lines, and the decoded page text carries
the per-line rates.

- **It is multi-line SQL, not the plan's single 1.5KB line.** Postgres string literals
  may contain newlines and drizzle's migrator splits only on `--> statement-breakpoint`.
  A template nobody can diff is a template nobody reviews.
- **`class="pre"` (`white-space: pre-line`) is on every multi-line field.**
  `org.address_lines` and `companies.address` are newline-separated free text, and merge
  substitution HTML-escapes but does not turn a newline into a `<br>` -- without it a
  three-line address prints as one run-on line. This is a real defect the plan's template
  had.
- **Its 26 merge tokens are asserted as an EQUALITY** against the list in
  `schema.test.ts`, in both directions. A field the template uses that nobody supplies is
  a silent blank on a printed page (unknown fields resolve to `""` and never throw); a
  field on the list the template stopped using is a context key built for nothing.
- **No literal `{{` appears in the CSS**, because it would be eaten as a merge field.
  The stylesheet DOES nest one at-rule (`@page { @bottom-center { ... } }`) and is safe
  because of the space between its opening braces; the test asserts every `{{` in the
  body is one of the 26 tokens, which catches an opening pair and nothing else. An
  earlier draft of this bullet said the CSS was flat, and the migration's own comment
  claimed the test also caught a closing `}}` -- it does not, and a `}}` is inert
  anyway. Both are corrected.
- **The logo is deliberately ABSENT.** `org_profile.logo_file_id` exists and the merge
  context carries `org.logoDataUri`, but the merge language has no conditional, so
  `<img src="{{org.logoDataUri}}">` would render `<img src="">` on every quote raised
  from an install with no logo. A missing logo is a plain letterhead; a broken image is
  an ugly PDF for everyone. **The cheapest fix is Task 4 supplying a transparent 1x1
  `data:` URI when no logo is set**, after which the slot can move into the default.
- **The footer carries page numbers and no merge field**, because a `{{...}}` inside a
  CSS string would be HTML-escaped, which is not CSS escaping.

**THREE THINGS THE NEXT TASKS INHERIT.**

1. **`truncateAll()` destroys the seeded template.** It empties every table in the
   `public` schema, read from the catalogue, so on the shared `conduit_test` database the
   seeded row is gone before any test body runs. **Task 4's service tests must seed their
   own quote template** -- including the immutability test, whose
   `update(documentTemplates)` would otherwise update zero rows and prove nothing. The
   seed is observable only in the from-the-files scratch database, which is where the
   0009 drill checks it.
2. **Task 4's `buildContext` must supply exactly these keys**, or the default template
   prints blanks: `org.{name,addressLines,email,phone,website,bankDetails,vatNumber,registrationNumber}`
   and `document.{number,issueDate,validUntilDate,recipientName,recipientContactName,recipientAddress,subtotal,tax,total,notes,terms}`,
   plus `description,qty,unitPrice,taxRate,lineTotal` per line. `recipientContactName`
   and `taxRate` are the two the review round added.

   `subtotal`/`tax`/`total` are FORMATTED strings, and **`formatMoneyCents` in
   `@conduit/shared` is now the one answer** -- see the review round below. `qty` and
   `taxRate` are NOT covered by it and still have no home: thousandths to "1.5" and
   basis points to "21%" are two more formatters Task 4 has to write, and they belong
   beside `formatMoneyCents` rather than inline in `buildContext`, for exactly the
   reason that one exists.
3. **Nothing bounds the number of line items, and the natural bound is arithmetic, not a
   guess.** The database cannot express "at most N rows per document" without a trigger,
   so it belongs in Task 4's input schema. The budget is the 128KB render input cap minus
   the merged template (2.7KB seeded, but a user may edit it) minus the inlined logo
   (32KB stored is ~43KB as a `data:` URI), leaving ~82KB. A rendered line costs about
   120 bytes of markup plus its description, so **a description cap is the other half of
   the bound** -- without one, a single line item can exhaust the budget alone. At a
   500-character description that is roughly 130 lines. Whatever the pair is, it must
   reject BEFORE the render rather than surfacing as `RenderError: input too large`, and
   if the input cap moves, both move.

##### TASK 2 REVIEW ROUND 1 — one real violation, and six smaller ones

All seven divergences above were adjudicated justified. Seven fixes landed on top; the
migration is still `0009_calm_rhodey.sql`.

**SV-1: the accepted domain and the storable domain were not the same, and it failed
AFTER the render.** `qty_milli` is `integer`, so a line caps at 2,147,483.647 units --
but `money.ts` only required a safe integer, which is 4.2 MILLION times wider. A
3,000,000-unit line therefore computed a correct running total in the form, passed
`documentTotals`, RENDERED THE PDF, and then died on the `INSERT` with `integer out of
range` (22003), inside the issuing transaction and after the subprocess had run: an
opaque 500 for a value the form had just called fine.

**Bounded in `money.ts` rather than widening the column, and the reasoning is not only
"2.1 million units is enough".** drizzle's `numeric()` yields a STRING unless it is
given an explicit `mode` (checked in `numeric.d.ts`: no mode is the string builder), so
widening would put a decimal string into arithmetic whose whole claim is that no
fractional number ever enters it -- the `numeric` would have to be parsed back to
thousandths at every boundary, which is the drift the units exist to prevent. The int4
range is a real limit honestly enforced; `numeric(12,3)` would be a wider limit enforced
by a conversion.

`tax_rate_bp` had the identical shape and is fixed with it -- also int4, also capable of
surviving the arithmetic and failing at the insert. The two are enforced by one
`exactInt4()`, and `schema.test.ts` now asserts both columns are still `integer` (with
`unit_price_cents` asserted `bigint` beside them as the contrast, since there the
safe-integer check is correctly the narrower side). Widening either column without
widening the arithmetic fails that test.

**The CHECK-level bounds are deliberately NOT pulled into `money.ts`**: `qty_milli >= 0`
and `tax_rate_bp BETWEEN 0 AND 10000` are business rules for Task 4's input schema, the
same "Zod is the primary gate, the CHECK is the backstop" split the schema comments
describe -- and this file keeps a wider domain there on purpose, because
`divideRoundHalfUp`'s negative branch exists so a future credit note rounds correctly.
**Task 4 still has to gate them, or the same after-the-render failure returns as a 23514
instead of a 22003.**

**O-4: `formatMoneyCents` in `@conduit/shared`, and all five web sites converged.**
Precision was never the problem; `undefined` was, since it means the VIEWER'S BROWSER
LOCALE. `MONEY_LOCALE` is the single knob and the parameter DEFAULTS to it rather than
being required at each call -- the failure being prevented is two call sites disagreeing,
and a default cannot be typed differently in six places.

**All five sites are converged, plus the one test helper**, because a half-converged
formatter is the same bug moved: the deal page would render Dutch while the quote form
rendered en-GB. `board-lib.test.ts`'s helper used to build its expectation with
`undefined` specifically to avoid pinning the machine's locale; it now pins
`MONEY_LOCALE`, and its comment says why that inverted.

Two things measured while writing it. **The exactness boundary is real but far out**: the
first cents value whose formatting disagrees with the exact decimal is
**7,036,874,417,766,401** (2^46 units; a `cents / 100` divide prints ...664.02 for
...664.01), identical in en-GB, nl-NL, en-US and de-DE because the loss happens before
Intl sees the number. **This round REFUSED amounts above it, which review round 2 records
as a regression** -- the fix is a BigInt decimal string rather than a ceiling; see F2
below. **And a limitation that is not new**: the divide by 100 and the currency's own
digit count only agree for currencies with a hundredth, so JPY reads 1,100,000 back as
11,000 yen. That is Conduit's stored model since `deals.value_cents`, unchanged from the
five sites this replaced, and a column problem rather than a formatting one -- pinned by
a test so it stays visible.

**O-8: `money.ts`'s safe-integer guard was one-sided, and now the columns hold the other
half.** It refused to PRODUCE a total past 2^53 but nothing refused to STORE one arriving
by another path -- psql, an import, a future service that skipped the shared arithmetic --
where `mode: "number"` would read it back as the nearest double. `documents_totals_representable`
covers subtotal, tax and total; `document_line_items_amounts_representable` covers
`unit_price_cents` and `line_total_cents` for the same reason.

**O-7: the line table prints each line's tax rate.** `tax_rate_bp` is per line, so a quote
mixing 21% and 9% work showed one blended figure the recipient could not take apart. The
table is now Description / Qty / Unit price / Tax / Amount, and `{{taxRate}}` is the 26th
merge token. Re-rendered on the server with mixed rates; figures above.

**O-6: a false comment in the migration.** It claimed the CSS was "flat, with no nested
at-rules crowding two braces together" while line 139 is `@page { @bottom-center { ... } }`.
The template is safe for a different reason -- the whitespace between the braces -- and
the comment now says that, and names the test that actually enforces it.

**O-5: an inverted dependency, noted at the test.** `schema.test.ts`'s template test
depends on the seeded row being GONE, which is the opposite of the warning above it. If
`truncateAll` is ever taught to preserve seed rows its first insert starts colliding, so
the test now asserts the table is empty first and says why at the point of failure.

**Migration mechanics, since 0009 changed after being generated.** It was REGENERATED
rather than hand-edited -- the two new CHECKs are drizzle-generated, so regenerating keeps
the snapshot exact instead of hand-editing 4,000 lines of JSON -- with the journal's
original `when` and `tag` restored afterwards, so the file name and timestamp are
unchanged and the journal diff is empty. `conduit_test` was dropped and recreated so the
migrator would apply the new file from scratch; the migrator skips by timestamp, so an
edited-in-place 0009 would otherwise never have reached it.

##### TASK 2 REVIEW ROUND 2 — a regression I introduced, and four guards that guarded nothing

**F2: converging the five sites turned an approximation into a crash, and the ceiling is
gone rather than widened.** `MAX_EXACT_CENTS` refused anything above 2^46 major units,
but `deals.value_cents` accepts any safe integer -- about 1.97e15 cents of API-legal
values that now THREW where the code they replaced merely printed an approximate figure.
It did not need one absurd deal either: `board-lib.ts` sums a stage's cents into a plain
number, so two deals of 5e15 are each under the ceiling and their sum is not. There is no
error boundary anywhere in `packages/web`, so that unmounted the application rather than
degrading a label.

The exactness now comes from the STRING, not from a limit. The decimal is built out of
the integer with BigInt -- no divide by 100 in double precision anywhere -- and handed to
`Intl.NumberFormat.prototype.format`, which takes a string exactly under Intl V3.

**What was verified about string formatting, since it decides whether this is safe.**
CI and the server both run Node 24 (`.github/workflows/test.yml` pins `node-version: "24"`;
the server measured `v24.19.0`). On that runtime `format("1234567890123456789.99")` comes
back with every digit intact, and `format("70368744177664.01")` -- the first value the old
divide got wrong -- is now exact.

For browsers, the app sets no `browserslist` and no vite `build.target`, so it inherits
vite's `baseline-widely-available` default, which reaches back to Firefox 104; Intl V3
string arguments landed in Firefox 116, Chrome 106 and Safari 15.4. **So there is a band
inside the build target that predates the feature, and it degrades rather than breaking**:
pre-V3 `format` coerces its argument with `ToNumber`, which turns the string into exactly
the double the old code passed. Measured rather than assumed -- on the server,
`format(Number("70368744177664.01"))` and `format(7036874417766401 / 100)` produce the
identical string, so the worst case is byte-for-byte the previous behaviour. **No
graceful-degradation branch is needed; the coercion IS the graceful degradation.**

The function now never throws for any input at all. A non-safe-integer -- NaN, Infinity, a
fraction -- takes the old `cents / 100` path and prints what it always printed, because
refusing it would put the crash back into display code for the one input class that is
already a symptom of something else. The documents path gets the same benefit: a quote
total between 7.03e15 and 9.00e15 used to compute, store, pass both CHECKs and then be
unprintable.

The JPY limitation stays pinned and is now explicit rather than incidental: two decimal
places always go IN, and the currency decides how many come out.

**Not fixed, and worth a decision later:** `stageValueLabel` still sums raw cents in a
plain number, so a stage whose deals exceed 2^53 in total shows an approximate figure. It
no longer crashes, and it was approximate before this phase too, so it is left alone
rather than quietly widened here.

**F1: the two representability CHECKs were effectively untested**, and three mutations
survived them green -- deleting the `line_total_cents` clause, deleting the `tax_cents`
clause, and narrowing every bound from `...991` to `...990`. The cause was one
out-of-range column per table, with `tax_cents` and `line_total_cents` never driven.

Each clause now gets its own case, with exactly ONE column out of range and the other two
still satisfying `documents_totals_consistent`, so the rejection can only have come from
the clause under test -- **asserted by constraint NAME**, because a bare 23514 cannot tell
the two constraints apart. The `tax_cents` clause is genuinely not redundant: the
reviewer's `subtotal = -...991, tax = 2 x ...991, total = ...991` satisfies both survivors
and the consistency CHECK.

**And the accepting side, which nothing asserted at all.**
`documentTotals([{ qtyMilli: 1000, unitPriceCents: 9007199254740991 }])` legitimately
emits exactly `...991`, so the narrowing mutation would have rejected a quote that had
already rendered and shipped green. Every bound is now pinned from both directions.
**All three mutations re-run and all three now fail.**

**F4: the negative int4 edge.** Deleting `value < INT4_MIN ||` from `exactInt4` left all
23 money tests green -- SV-1's failure in the one direction SV-1's fix never tested, and
the direction a credit note rides. int4 is asymmetric, so neither bound implies the other;
both ends of both columns are now pinned, and the mutation fails two tests.

**F5: `MONEY_LOCALE`'s VALUE is pinned**, not merely "some locale that is not
comma-decimal". Changing it to `en-US` passed all 17 test files; it now fails one.

**F3 and F8: the comment O-6 corrected was still wrong, and the bullet above it was never
touched.** The migration claimed the test catches a future edit that closes two at-rules
together. It does not -- `color: #888;}}` produces no `{{` to count, and an unmatched
`}}` is inert to a Mustache-shaped parser anyway. The guard is load-bearing for an
OPENING pair, which is the case that is not harmless, and the comment now says that and
says what it does not cover. The DONE block's "the CSS is flat with no nested at-rules"
bullet -- the exact claim O-6 recorded as false -- is corrected too, along with its "25
tokens" (26 is right).

**F7: nothing rendered the seeded template, and now something does.**
`packages/api/src/services/documents-seed.test.ts` reads the template out of the migration,
strips every merge construct and renders it, gated on the binary the way
`documents-render.test.ts`'s real half is -- so CI runs it on every push.

**It deliberately does not merge.** Task 3 owns the resolver and its block syntax is
already ruled to change, so a stand-in here would be a second implementation that goes
stale by design. Stripping is correct under any of those languages for the one context
this file cares about, and leaves exactly the stylesheet and markup, which is what was
unguarded. Beyond `%PDF-`, it asserts the empty quote is ONE page and that the MediaBox is
A4 (595.28 x 841.89pt) -- `@page { size: A4 }` being the line a careless edit changes
silently, and one that is only wrong once it is on paper. Mutating it to `Letter` fails
the test at 612pt. **A FILLED render belongs in Task 4, beside the real `buildContext`.**

**AND IT WENT RED ON CI FIRST, on the exact trap Task 1's retrospective records.** Run
`33213343537` failed both render assertions. WeasyPrint **61.1** (the Ubuntu 24.04 runner)
compresses object streams by default while **57.2** (the Debian 12 server) does not, so
the page tree is plain text here and invisible there -- which is the same reason
`/EmbeddedFiles` once looked absent on 61.1, written down in this plan, read during this
task, and walked into anyway. The reader now inflates every Flate stream before searching,
mirroring `pdfEmbedsFiles`'s loop (already proved against 61.1 by Task 1's mutation run),
and page count comes from the page tree's own `/Count` rather than from counting page
objects.

**A THIRD TEST PINS THE READER ITSELF, and it needs no renderer at all**: a hand-built PDF
whose page tree exists ONLY inside a compressed object stream, with the raw bytes asserted
not to contain `/MediaBox` first. Without it the parser would only ever be exercised
against the uncompressed output of the one WeasyPrint on the development server -- and the
version that matters is the other one. The lesson is Task 1's own, one level up: a
version-specific representation is not a property, and the property here is "the page tree
says A4", not "the bytes contain `/MediaBox`".

Minor, confirmed: `deal-detail.tsx:183`'s surviving `/ 100` is an edit value feeding
`parseDecimal`, not a display path, and is left alone.

---

### Task 3: Templates — the sanitiser profile and merge resolution

**Files:**
- Create: `packages/api/src/services/documents-template.ts`, `documents-template.test.ts`

Both halves are pure functions. Everything about this task is unit-testable without a
database, and it should be tested to exhaustion — it is the layer that turns
user-authored HTML into something a renderer is handed.

#### COORDINATOR RULING — the block form generalises beyond `lines`

Task 2 found that the seeded template cannot include the org logo at all. The merge
language as specified has no conditional, so `<img src="{{org.logoDataUri}}">` renders
`<img src="">` on every install that has not uploaded one — a broken image on every
quote by default. Task 2 dropped the logo from the seed rather than ship that, and
proposed Task 4 supply a transparent 1x1 placeholder.

**Ruling: generalise the block instead.** `mergeTemplate` already parses
`{{#lines}}...{{/lines}}`; extend that same parser so `{{#path}}...{{/path}}` renders its
body when the value at `path` is non-empty and renders nothing when it is empty or
unknown, with `lines` remaining the repeated case. That is Mustache's own semantics, so
it will not surprise anyone, and it is a small generalisation of code this task writes
regardless.

The 1x1 placeholder was rejected because it treats one symptom: **every optional field
has this problem**, not just the logo. `valid_until_date`, `vat_number`,
`registration_number`, `bank_details` and the recipient's second address line are all
routinely empty, and each currently renders its surrounding markup — an empty "VAT:"
label, a bare heading over nothing. A conditional block fixes the class; a placeholder
image fixes one instance and leaves the rest.

Requirements:
- `{{#path}}...{{/path}}` and its inverse `{{^path}}...{{/path}}` (render when EMPTY),
  which is what lets a template say "VAT number, or nothing at all".
- Empty means empty string, and an unknown path is empty — consistent with the existing
  rule that an unknown scalar renders as empty and never throws.
- Blocks do not nest in the first cut. If a template nests them, the behaviour must be
  defined and tested rather than accidental — a regex-based parser will do something,
  and what it does must be written down.
- The seeded template is then updated to wrap the logo and every optional field, and
  re-rendered on the server to confirm both the with-logo and without-logo cases.



- [ ] **Step 1: Write the failing tests**

`packages/api/src/services/documents-template.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sanitizeDocumentHtml, mergeTemplate } from "./documents-template.ts";

describe("sanitizeDocumentHtml", () => {
  it("keeps the CSS that page layout depends on", () => {
    const html = sanitizeDocumentHtml('<style>@page { margin: 20mm; }</style><p style="color:#111">hi</p>');
    expect(html).toContain("@page");
    expect(html).toContain('style="color:#111"');
  });

  it("keeps tables", () => {
    expect(sanitizeDocumentHtml("<table><tr><td>a</td></tr></table>")).toContain("<td>a</td>");
  });

  it("keeps a data-URI image", () => {
    const html = sanitizeDocumentHtml('<img src="data:image/png;base64,iVBOR">');
    expect(html).toContain("data:image/png;base64,iVBOR");
  });

  it("strips script elements", () => {
    expect(sanitizeDocumentHtml("<p>a</p><script>alert(1)</script>")).not.toContain("alert");
  });

  it("strips event handlers", () => {
    expect(sanitizeDocumentHtml('<p onclick="alert(1)">a</p>')).not.toContain("onclick");
  });

  it("strips javascript: URLs", () => {
    expect(sanitizeDocumentHtml('<a href="javascript:alert(1)">a</a>')).not.toContain("javascript:");
  });

  // This is what enforces the no-network property, rather than trusting the
  // renderer's flags: a remote asset cannot survive into the HTML at all.
  it("strips a remote image source", () => {
    expect(sanitizeDocumentHtml('<img src="https://evil.test/x.png">')).not.toContain("evil.test");
  });

  it("strips iframes and objects", () => {
    const html = sanitizeDocumentHtml('<iframe src="data:text/html,x"></iframe><object></object>');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<object");
  });
});

describe("mergeTemplate", () => {
  const context = {
    org: { name: "Listerdale", addressLines: "1 High St", email: "", vatNumber: "", registrationNumber: "", phone: "", website: "", bankDetails: "", logoDataUri: "" },
    document: {
      number: "QUO-2026-0001", issueDate: "2026-08-28", validUntilDate: "", recipientName: "Acme",
      recipientAddress: "2 Low St", subtotal: "100.00", tax: "21.00", total: "121.00", notes: "", terms: "",
    },
    lines: [
      { description: "Widget", qty: "2", unitPrice: "50.00", lineTotal: "100.00" },
    ],
  };

  it("substitutes a scalar field", () => {
    expect(mergeTemplate("Quote {{document.number}}", context)).toBe("Quote QUO-2026-0001");
  });

  it("repeats a line block once per line", () => {
    const out = mergeTemplate("{{#lines}}<i>{{description}}</i>{{/lines}}", context);
    expect(out).toBe("<i>Widget</i>");
  });

  it("repeats a line block for every line", () => {
    const two = { ...context, lines: [context.lines[0], { ...context.lines[0], description: "Sprocket" }] };
    const out = mergeTemplate("{{#lines}}[{{description}}]{{/lines}}", two);
    expect(out).toBe("[Widget][Sprocket]");
  });

  it("renders an empty line block for no lines", () => {
    expect(mergeTemplate("a{{#lines}}x{{/lines}}b", { ...context, lines: [] })).toBe("ab");
  });

  // A typo in a template is a blank on a page, never a 500.
  it("renders an unknown field as empty rather than throwing", () => {
    expect(mergeTemplate("[{{document.nope}}][{{nope.nope}}]", context)).toBe("[][]");
  });

  it("escapes HTML in substituted values", () => {
    const evil = { ...context, document: { ...context.document, recipientName: "<script>x</script>" } };
    expect(mergeTemplate("{{document.recipientName}}", evil)).not.toContain("<script>");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/api/src/services/documents-template.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement**

`packages/api/src/services/documents-template.ts`:

```ts
import sanitizeHtml from "sanitize-html";

/**
 * The DOCUMENT sanitiser profile -- deliberately NOT sanitizeMailHtml's.
 *
 * Mail's profile defangs HTML written by strangers and strips exactly the CSS that
 * page layout needs. A document is written by an authenticated user of this CRM and
 * rendered offline into a PDF, never into a browser context carrying a session, so
 * the trade is different: layout CSS is allowed, and everything executable or remote
 * is not.
 *
 * The remote-URL rule is load-bearing beyond XSS. documents-render.ts sets no
 * --base-url so a surviving remote reference could not resolve anyway; stripping it
 * here means the no-network property holds at the input rather than depending on a
 * renderer flag nobody re-checks.
 */
export function sanitizeDocumentHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "html", "head", "body", "style", "div", "span", "p", "br", "hr",
      "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "small",
      "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "img", "a",
    ],
    allowedAttributes: { "*": ["style", "class"], img: ["src", "width", "height", "alt"], a: ["href"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] },
    // Only data: for images, and no scheme at all is treated as relative-and-dropped
    // by allowProtocolRelative: false plus the empty allowedSchemes for hrefs.
    allowedSchemesByTag: { img: ["data"], a: ["mailto"] },
    allowProtocolRelative: false,
    allowedStyles: {},
    // `style` elements pass through with their content intact; sanitize-html drops
    // the text of non-text tags unless they are named here.
    nonTextTags: ["script", "textarea", "noscript", "iframe", "object", "embed"],
    allowVulnerableTags: false,
  });
}

export interface MergeLine { description: string; qty: string; unitPrice: string; lineTotal: string }
export interface MergeContext {
  org: Record<string, string>;
  document: Record<string, string>;
  lines: MergeLine[];
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const FIELD = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;
const LINE_BLOCK = /\{\{#lines\}\}([\s\S]*?)\{\{\/lines\}\}/g;

function substitute(template: string, lookup: (path: string) => string): string {
  return template.replace(FIELD, (_match, path: string) => escapeHtml(lookup(path)));
}

/**
 * Merge fields into a template. Two forms only: `{{a.b}}` for a scalar and
 * `{{#lines}}...{{/lines}}` repeated per line item. Not a general template language,
 * on purpose -- a quote needs a header, a table and totals.
 *
 * An unknown path yields "". A template is edited by hand in a textarea and a typo
 * must produce a blank, not a failed render an hour before a quote is due.
 */
export function mergeTemplate(template: string, context: MergeContext): string {
  const withLines = template.replace(LINE_BLOCK, (_match, body: string) =>
    context.lines.map((line) =>
      substitute(body, (path) => (path in line ? String(line[path as keyof MergeLine]) : ""))).join(""));

  return substitute(withLines, (path) => {
    const [head, tail] = path.split(".");
    if (tail === undefined) return "";
    const bag = head === "org" ? context.org : head === "document" ? context.document : undefined;
    return bag?.[tail] ?? "";
  });
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run packages/api/src/services/documents-template.test.ts`
Expected: PASS, 16 tests. If the `style`-element test fails, check `nonTextTags` — it
replaces the default list, and omitting `style` from it is what keeps the CSS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/documents-template.ts packages/api/src/services/documents-template.test.ts
git commit -m "feat(api): the document sanitiser profile, and merge-field resolution"
```

#### TASK 3 DONE — a scanner instead of a regex, and the spec's strip-list is wrong

Commits `f951e32`, `551428a`, `1b0ee8d`. CI run **33217909751**, tip `1b0ee8d`, both
jobs green: **2160 tests, 0 skipped**. On the server: 2122 passed / 38 skipped.
`documents-template.test.ts` is 203 unit tests plus 2 gated on the binary; the seed's
own file grew 6.

The steps above are left as written so the corrections are legible.

**1. A HAND-WRITTEN SCANNER, NOT THE PLAN'S TWO REGEXES, and the reason is that a
regex has no answer rather than a wrong one.** Generalising
`{{#lines}}([\s\S]*?){{/lines}}` to arbitrary paths needs a backreference, and the
lazy quantifier then decides three questions nobody asked it: a block inside a block
stops at the FIRST closer, leaving the inner tags on the printed page as literal
text; an unclosed block matches nothing, so both its tags print; a `{{/other}}` inside
a `{{#path}}` prints too. Each of those is an artefact of the quantifier. The scanner
makes each one a decision, and each decision is tested:

| input | what happens | why that one |
|---|---|---|
| `{{#a}}..{{#b}}..{{/b}}..{{/a}}` | nests properly; closers match by depth | falls out of a scanner and costs nothing |
| `{{#a}}x` (never closed) | the block is IGNORED, `x` renders as ordinary content | the alternative -- treating the rest of the template as the body -- DELETES the rest of the quote whenever the value is empty, silently |
| `{{/a}}` with nothing open | dropped | |
| `{{#a}}x{{/b}}` | `{{/b}}` dropped, so `a` is unclosed, so the row above | |
| `{{ }}`, `{{1a}}`, `{{{a}}}`, `{{__proto__}}` | emitted verbatim | visible feedback on the page for whoever is editing the template. **`{{ oops }}` is NOT one of these** -- surrounding whitespace is tolerated, so it is a tag for an unknown path and renders blank, which is Mustache's behaviour. An earlier draft of this row said otherwise |
| `{{#lines}}` inside `{{#lines}}` | n^2 rows: `lines` is not a field of a line, so the inner block resolves it from the root again | defined, tested, and bounded by MERGE_MAX_STEPS -- **which is NOT what the first version of this task shipped; see review round 1** |

It is also linear, rather than a rescan from every `{{` in a 128KB template.

**Two things the scanner gained that the plan's version did not have.** Inside
`{{#lines}}` the plan looked ONLY at the line's own fields, so `{{document.number}}` on
a line row rendered blank; there is a scope stack now, innermost first, which is
Mustache's rule. And lookups are own-property only: `{{constructor}}` is a blank rather
than `function Object()`. The FIELD form never showed that (a field only ever emits a
string) -- the BLOCK form does, and `{{#constructor}}x{{/constructor}}` is the test that
fails when the check is removed.

**THREE BOUNDS, AND THIS PARAGRAPH ORIGINALLY CLAIMED ONE, WHICH DID NOT TERMINATE.**
Blocks nest, so expansion is not linear in the template. The shipped version of this
task bounded the merge on OUTPUT CHARACTERS alone, and a reviewer showed that bounds
nothing: the cap is only reached by a node that EMITS, so a nest whose innermost body
emits nothing runs `lines.length ** depth` times with the count stuck at zero. The
bound is now on WORK -- a node visited or a block expanded -- plus a recursion depth
limit, plus the original memory cap. All three throw `TemplateError`. See review
round 1 for the measurements.

**2. THE SPEC'S STRIP-LIST WAS WRONG AND THIS PROFILE DOES NOT IMPLEMENT IT.** The spec
said "any remote URL in any attribute". `file:` is not remote, and `file:` is the one
that has actually been used against this codebase. **The coordinator has since
corrected the spec itself** (`655691a`) to say every URL in every attribute except
`data:` and a bare fragment, so this divergence is now the spec. The rule is an
ALLOWLIST: exactly `data:`, plus a bare fragment (`#terms`, which names a place inside
this document and can reach nothing). Everything else goes -- `file:`, `http:`,
`https:`, `ftp:`, `jar:`, `//host`, `/etc/passwd`, `logo.png`, `javascript:`,
`vbscript:`, `blob:`, `filesystem:`, a UNC path, and **`mailto:` and `tel:`, which the
plan's Step 3 allowed**. Each is a test, in each of seven positions.

**`mailto:` AND `tel:` ARE A DEFERRED CAPABILITY, NOT A DANGER, and the review round
settled which.** No href of any scheme reaches the renderer's fetcher -- every one of
them is an inert `/URI` annotation -- so the reason they are refused is allowlist
minimality and nothing else. A quote that links the issuer's email address is a
plausible thing to want. Restoring it is two entries in `isPermittedUrl`, scoped to
its `"link"` position so it cannot widen a fetch.

**3. THE MATRIX: WHAT THE RENDERER ALSO CATCHES, AND WHAT ONLY THIS CATCHES.** Measured
on the server through the shipped `renderPdf` (WeasyPrint 57.2), not reasoned about.

| vector | renderer | sanitiser | measured |
|---|---|---|---|
| `file:`/`http:`/`ftp:`/`jar:` in `img src` or `link rel=stylesheet` | control 1 blocks, render FAILS | strips | Task 1's per-scheme suite |
| `url()` in a `<style>` block or a `style` attribute | control 1 blocks, render FAILS | strips | exit 2, file never opened |
| `@import`, both `url(...)` and a bare string | control 1 blocks, render FAILS | strips | exit 2 |
| `@font-face { src: url(file://...) }` | control 1 blocks, render FAILS | strips | exit 2 |
| CSS-escaped `\75 rl(...)` and `@\69 mport` | control 1 blocks, render FAILS | strips, because it decodes escapes | exit 2 -- tinycss2 decodes them, so they are URLs and not text |
| `rel=attachment` on `<link>` and `<a>` | controls 2 and 3 | strips (the tag is not allowed, `rel` is not allowed) | Task 1's mutation run |
| **`<a href="file:///...">`** | **NOTHING. Renders, exits 0** | **the only control** | the PDF comes back with `/URI (file:///etc/hostname)` in it and the file is never opened: an href is not fetched, it is written into the PDF as a link annotation |
| **`<a href="http://...">`** | **NOTHING. Renders, exits 0** | **the only control** | same, `/URI (http://example.test/x)` -- a live tracking link inside a quote you emailed a customer |
| **protocol-relative `//host/x.png`, and any relative URL** | renders, fetches nothing (base_url is None); the asset is silently missing | **the only control** | 838-byte PDF, nothing blocked |
| **`<script>`, `on*`, `javascript:`** | irrelevant, there is no JS engine | **the only control** | matters the moment a template is previewed in a browser, which is Task 5's surface |
| `image-set("file://..." 1x)` | renders, fetches nothing on 57.2 | NOT covered: a bare string outside `@import` is not treated as a URL | 2,895-byte PDF, file never opened. If a later version does fetch it, control 1 refuses it |

The rows in bold are the answer to "why does this module exist when the renderer has
three controls": **the renderer's controls are about what it FETCHES, and an href is
never fetched.** Two of them are pinned by tests in `documents-template.test.ts` that
render on the real binary and assert both halves -- the renderer has no opinion, the
sanitiser removes it.

**4. sanitize-html DOES NOT FILTER CSS AT ALL, in either position, and the plan's
options say otherwise in three places.** All three measured against 2.17.7:

- The contents of an allowed `<style>` element are emitted **verbatim**, in every
  configuration. `nonTextTags` has nothing to do with it -- the plan's comment
  ("sanitize-html drops the text of non-text tags unless they are named here") is false
  for an ALLOWED tag, and overriding that list would only have dropped the library's own
  mutation-XSS mitigations for `xmp` and `textarea`. It is left alone.
- `allowedStyles: {}` does not filter a `style` attribute, it DISABLES filtering:
  `filterCss` returns the tree untouched when no rule matches. The plan's profile would
  have passed `style="background:url(file:///etc/passwd)"` straight through.
- `allowVulnerableTags: false` with `style` in `allowedTags` prints a console warning on
  every single call. It is true here, with a comment saying what the warning is about
  and why it does not apply to a document rendered offline.

So the CSS is sanitised here, by a scanner that decodes escapes -- because
`\75 rl("file:///etc/passwd")` and `@\69 mport` both FETCHED on the server, so a regex
over the raw text is not a control. Two subtleties are load-bearing and both are
tested: a comment is replaced by a SPACE rather than deleted (`url/**/(x)` is not a url
token, and deleting the comment would make it one), and every removal leaves a space
behind (a deletion joins the text on either side of it, which is how a `<` and a
`/style>` could become `</style>` and end the element early when the output is parsed
again).

**5. THE ESCAPING ORDER: MERGE FIRST, SANITISE LAST, and `prepareDocumentHtml` is the
only call Task 4 should make.** Both directions are tested, and one of the tests is a
mutation test for the order itself:

- Values are HTML-escaped on substitution, including `'` -- which the plan's escaper
  missed, and `<img alt='{{x}}'>` is legal HTML that it broke out of. Escaping is what
  stops a company name of `<style>@page{size:Letter}</style>` restyling the document,
  because the sanitiser would have ALLOWED that: it is exactly what a template is
  permitted to contain.
- HTML escaping is escaping for ONE context. A value landing inside a `<style>` block is
  in another one, where `<` and `&` are not what matters and `url(` is. Sanitising the
  template first and merging into it afterwards leaves a `file://` URL in the stylesheet
  that nothing ever looked at -- and the test asserts exactly that about the wrong
  order, so swapping the two calls makes the right-order test fail.
- ~~A merge field in a style ATTRIBUTE is destroyed outright by sanitize-html's postcss
  parse, which closes that context by construction.~~ **WRONG ON BOTH HALVES, corrected
  in review round 1.** The destruction only happens to an UNMERGED template, which is
  the wrong order; through `prepareDocumentHtml` the value is substituted first and the
  attribute survives carrying it. That attribute is now the ONLY CSS context a value
  can reach, because merge fields inside a `<style>` block are no longer substituted at
  all. **The seeded template has no merge field in either CSS position**, and there is a
  test that says so.

**6. THE RE-SEED.** Every optional field is wrapped: the logo, the valid-until row, the
contact name, the recipient address, the notes, the terms, the bank details, the VAT
number, the registration number and each of the org's contact lines. The line table
gets a `{{^lines}}` empty state. **54 merge tokens**, up from 26, still asserted as an
equality in `schema.test.ts` -- where the optional ones are now a named list, because
"this field owes the template a conditional" is the contract that moved.

Rendered on the server through the shipped `renderPdf`, in both states:

| state | merged HTML | PDF on 57.2 (server) | PDF on 61.1 (CI) | image XObject |
|---|---|---|---|---|
| no logo, nothing optional filled in | 3,445 chars | 14,383 bytes, 1 page | 10,982 bytes, 1 page | **none** |
| everything filled in | 4,073 chars | 16,640 bytes, 2 pages | 12,813 bytes, 2 pages | one |

16,640 was 16,641 on the next run: the renderer is not byte-reproducible, which Task 1
measured and Task 4's immutability test depends on. The no-logo case has no `<img>` at
all, no "Valid until" row, no "VAT" and no "Company registration" -- asserted on the
merged HTML and again on the PDF, where an image XObject either exists or does not.
**`documents-seed.test.ts` now MERGES** rather than stripping merge constructs with a
regex; the reason it did not is that Task 3 owned the resolver, and Task 3 has landed.

**Migration mechanics: `drizzle-kit generate` reports "No schema changes".** The edit is
to hand-written seed data, not to generated DDL, so there is nothing for drizzle to
regenerate and the journal and the snapshot are untouched -- the diff is one `.sql`
file. `conduit_test` was dropped and recreated anyway, because the migrator skips by
timestamp and the tests would otherwise have run against the old template while the
file on disk said something else.

**7. MUTATION-CHECKED, because three of Task 1's assertions proved nothing until
somebody did.** Every mutation run against the suite on the server:

| mutation | fails |
|---|---|
| the `<style>` block CSS pass removed | **91 of 203** |
| the `style` attribute CSS pass removed | 19 |
| the attribute URL allowlist removed (leaving sanitize-html's own scheme list) | 6 |
| CSS hex escapes not decoded | 1 |
| a removed url token leaves nothing behind instead of a space | 1 |
| `url` must be followed IMMEDIATELY by `(` (the strict grammar) | 1 |
| `exclusiveFilter` removed, so an `<img>` with no src survives | 1 |
| sanitise before merge | 1 |
| `'` not escaped | 1 |
| the own-property check dropped from `lookup` | 1 |
| whitespace-only no longer counts as empty | 1 |
| an unclosed block becomes a section | 1 |
| the output cap removed | 1 |
| no outer scope from inside a line | 3 |

**And one that is REDUNDANT AND SAYS SO.** Removing the `rel=attachment` strip fails
nothing, because `rel` is not in the allowed attributes; allowing `rel` on `<a>` while
keeping the strip fails nothing either. Removing BOTH reopens the vector and fails one
test. That is what redundancy looks like from a test suite, and the strip earns its
place because "allow `rel` so links can carry `noopener`" is an ordinary-looking edit.
Recorded at the constant rather than left for the next person to rediscover.

**8. AND IT WENT RED ON CI ON THE TRAP THIS PLAN RECORDS TWICE.** Run `33217280123`
failed one assertion: `/URI (file:///etc/hostname)` is plain text in 57.2's output and
lives inside a compressed object stream on 61.1, so the raw byte search found it on the
server and not on the runner. **The negative half of that same test is the one that
mattered** -- `not.toContain` over raw bytes would have passed VACUOUSLY on 61.1 for as
long as it existed. The inflate-every-stream loop had already been written twice
(`pdfEmbedsFiles` ships it, `documents-seed.test.ts` had a copy), so rather than add a
third it moved to `packages/api/src/test/pdf.ts` as `pdfText`/`pageCount`/`pdfHasImage`,
still pinned by the hand-built PDF whose page tree exists only inside a compressed
object stream -- which needs no renderer of any version to prove.

**WHAT TASKS 4 AND 5 INHERIT.**

1. **Call `prepareDocumentHtml(template, context)`.** It is merge-then-sanitise in one
   place, so the order cannot be got wrong at a call site. Sanitising again when a
   template is SAVED is harmless -- the profile is idempotent and there is a test -- but
   it is not the control.
2. **`MergeContext` now needs `org.logoDataUri`**, which the seed uses. Every other key
   is Task 2's list unchanged. A missing key is a blank, never a throw.
3. **`mergeTemplate` throws `TemplateError` and nothing else**, from any of three
   bounds: 1,000,000 steps of work, 32 levels of nesting, 512K characters of output.
   (The original version of this line said the character cap was the only one, which
   was both incomplete and, for a deep template, false -- it was a `RangeError`.) Task
   4's route should turn it into an error about the TEMPLATE rather than a 500 -- it
   happens before the render, so no document number is spent either way.
4. **The profile refuses `mailto:` and `tel:`.** Task 5's merge-field documentation page
   should say that a template's links can only be fragments or `data:`, and that the
   org's email prints as text.
5. **Merge fields are NOT SUBSTITUTED inside a `<style>` block at all** -- the token is
   left where it stands -- and the documentation page should say that rather than
   describing what the escaping would have done. In a `style` ATTRIBUTE they are
   substituted, the attribute survives, and any URL in the value is removed by the CSS
   scanner. **`documentTemplateWarnings(template)` is exported for the editor** and
   names every case where this module does something silently; see round 2.
6. **`{{^lines}}` means a quote with no lines renders "No line items."** rather than an
   empty table. Task 4 should still require at least one line in its input schema; the
   empty state is for the template's benefit, not a supported document.

**OPEN, and it belongs to Task 6.** Task 1's note that the `e2e` job does not install
WeasyPrint is unchanged. Everything in this task now runs on both versions on every
push -- the two gated tests and the seed's two states render on the runner's 61.1 -- so
the 57.2/61.1 gap is closed for this module, but not for the phase.

##### TASK 3 REVIEW ROUND 1 — a merge that did not terminate, and a tokenizer I only half agreed with

Commit `10cd768`. CI run **33221772496**, tip `10cd768`, both jobs green: **2173 tests,
0 skipped**. On the server: 2135 passed / 38 skipped.

The review could not break the refusal matrix -- 26 URL forms across 13 positions
re-derived independently, every evasion refused -- and confirmed the scope stack, the
own-property lookup, the `rel=attachment` redundancy, the three library claims against
2.17.7, structural attacks on `STYLE_ELEMENT`, 30+ malformed-template shapes and both
re-seed renders. What it broke was the merge's termination and my agreement with the
CSS tokenizer.

**S2: THE MERGE DID NOT TERMINATE, AND THE CAP I SHIPPED BOUNDED NOTHING.**
`MERGE_MAX_OUTPUT_CHARS` is checked in `emit`, and `emit` is only reached by a node
that produces characters. A section whose body emits nothing -- an empty body, or one
holding only an unknown field, since `emit(sink, "")` adds zero -- never touches it, so
the loop ran `lines.length ** depth` times with the counter at zero. `mergeTemplate` is
synchronous, so that is the whole Node event loop, from a template a user can save.
The reviewer measured, with twenty line items: depth 6 at 1.5s and no throw, depth 7 at
30s and no throw, depth 12 at 4.1e15 iterations from a **240-character template**.

**My own cap test is why it survived**: it put `{{description}}` in the body, so it
always emitted and always hit the cap. The mutation that "proved" the cap only ever
exercised the emitting case.

**The bound is now on WORK -- a node visited or a block expanded -- not on output.**
Re-measured on the server against the fix, twenty line items throughout:

| body | depth | before | after |
|---|---|---|---|
| empty | 6 | 1.5s, no throw | **78ms, TemplateError** |
| empty | 7 | 30s, no throw | **51ms** |
| empty | 9 | -- | **50ms** |
| empty | 12 | ~10^4 hours, no throw | **52ms** |
| empty | 20 | -- | **69ms** |
| one unknown field | 9 | 31s, no throw | **288ms** |
| one unknown field | 12 | -- | **329ms** |

**THE 5x SWING IN THE LAST TWO ROWS IS A HOLE, NOT NOISE, and round 2 is where that
was noticed.** Identical step counts costing five times as much means the cost of a
step was not bounded -- see round 2, finding 1.
| `{{description}}` | 7 | output cap | **19ms**, output cap at 53,853 steps |

And the other direction, which a bound needs just as much: **the seeded template merges
in 1,612 steps at 130 line items** -- the largest quote that can render at all -- and
148 steps at eight. The cap is 1,000,000.

**S3: it threw a `RangeError`, not a `TemplateError`.** `render` recurses once per
nesting level, so a template nested thousands deep failed out of the JavaScript stack.
The DONE block handed Task 4 "TemplateError past 512K characters, and that is its only
throw", and a route written to that contract turns this into a 500. `MERGE_MAX_DEPTH`
is 32; the 20,000-deep case now stops in 11ms after 66 steps with a `TemplateError`
naming the nesting, and the test asserts it is not a `RangeError`.

**S1: MY STRING READER DISAGREED WITH tinycss2, AND A LIVE `url()` WALKED OUT.**
`readString` ended a string at `"\n"`. CSS Syntax 3 preprocesses CR, FF and CRLF each
into a single LF before tokenizing, so a real tokenizer ends a bad-string at a bare CR
too -- and mine copied everything after the CR out as string content:

```
<style>p{content:'x<CR>} p{background:url(file:///etc/passwd)} p{a:'}</style>
```

The reviewer fed my own output to a recording fetcher on the server and WeasyPrint
asked for the file. **It was contained only by the renderer's `data:`-only fetcher** --
which is precisely the dependency this module exists to remove, and which does not
exist in Task 5's in-browser template preview, where the same payload is a live
outbound request from the operator's browser. It falsified the invariant stated at
`sanitizeCss` and the header's claim about not resting on a renderer flag.

Fixed by breaking on `\n`, `\r` and `\f`. **The `HIDDEN` table had no case where a URL
hid inside a CSS STRING** -- thirteen cases on escapes, comments and at-rules, and none
on the shape that got through. Five string shapes added (bare CR, FF, CRLF, double
quotes, end-of-line); reverting the fix fails three of them.

**THE SMALLER FIVE.**

- **O1: `data:` on an `<a href>` is now refused, deliberately.** It was permitted as a
  side effect of "exactly `data:` everywhere", and `<a href="data:text/html,...">` rode
  out into a `/URI` annotation. `isPermittedUrl` now takes a position: a "fetch" (an
  `img src`, a CSS `url()`, an `@import`) may be `data:`, because that is how the logo
  arrives; a "link" may be a fragment and nothing else, because an href is never
  fetched and `data:` buys it nothing.
- **O2: the DONE block's claim that a merge field in a `style` attribute is destroyed
  was wrong on mechanism and on consequence**, and Task 5 was told to write its
  documentation from it. `parseStyleAttributes` defaults to true, so postcss parses the
  value even with `allowedStyles` unset -- the filter is off, not the parse -- and the
  destruction only happens to an UNMERGED template. Through `prepareDocumentHtml` the
  value is substituted first and **the attribute survives with it**. Corrected in place
  above, and the test that asserted the wrong thing now asserts both halves.
- **O3: a merged value ending in a backslash swallowed the rest of the stylesheet**,
  faithfully to CSS: the backslash escapes the closing quote of the string it landed
  in. Rather than document that, **merge fields inside a `<style>` block are no longer
  substituted at all.** The token is left where it stands. It kills the whole class --
  the backslash, the `&quot;` that CSS does not decode, and a `url()` only the sanitiser
  would have caught -- and it makes the advice Task 5 has to publish one sentence long.
  The region scan is htmlparser2's own raw-text rule (a `<style ...>` runs to the first
  `</style`), and it can only err by treating a field as CSS when it is not, which
  leaves a token unrendered rather than a value unchecked.
- **O4 and O5: two comments that were wrong about which mechanism handled a case.**
  `{{ oops }}` renders blank, not verbatim -- `TAG` tolerates surrounding whitespace,
  which is Mustache's behaviour and correct. `{{__proto__}}` prints as literal text
  because `TAG` requires a leading letter, not because `lookup` refused it;
  `{{org.__proto__.x}}` is the one `lookup` handles. Both corrected.

**THE ORDER TEST NEEDED A REAL PAYLOAD, and finding one made the argument better.**
With `<style>` blocks no longer merged, the old demonstration was gone -- and the
obvious replacement, a bare `url(file://...)` merged into a `style` attribute, does not
survive the wrong order either, because sanitising an unmerged template destroys that
attribute. The payload that does survive is sharper, and it is the case where HTML
escaping looks like it should have been enough:

```
template: <div style="background: url(data:image/png;base64,{{document.notes}})">
value:    x")} body{background:url(file:///etc/passwd)} p{a:("
```

The value's quote is escaped to `&quot;` -- and the HTML parser hands `&quot;` back to
the CSS parser as a real quote, so the escape travels through the attribute and closes
the `url()` from the inside. Measured, wrong order:

```
<div style="background:url(&quot;data:image/png;base64,x&quot;)}
 body{background:url(file:///etc/passwd)} p{a:(&quot;&quot;)">x</div>
```

Right order: `<div>x</div>`.

**MUTATIONS FOR THE FIXES**, all run on the server:

| mutation | result |
|---|---|
| CSS string ends only at `\n` | 3 of 216 fail |
| the work budget removed | **the run HANGS** (killed at 120s) |
| the depth cap removed | 1 fails |
| `data:` allowed on an href again | 1 fails |
| `<style>` blocks merged again | 2 fail |
| expansions counted, nodes not | (not run: the node count is what terminates) |
| **expansions NOT counted, nodes still counted** | **0 fail -- see below** |

Two of those need saying plainly. **The work budget's mutation hangs rather than
fails**, because `mergeTemplate` is synchronous and vitest's timer cannot fire until it
returns -- which is the argument for the bound living in the module rather than in a
test's patience, and the test comments now say so instead of claiming a timeout catches
it. And **counting expansions as well as nodes fails no test**: node counting alone
terminates, since an expansion that visits no nodes can only happen at the innermost
level. What the per-item count buys is the constant -- without it a 130-line quote
could do 1.3e8 iterations inside the same one-million-step budget, seconds of blocked
event loop rather than a third of a second. Recorded at the line, like the
`rel=attachment` redundancy above it.

**WHAT CHANGED FOR TASKS 4 AND 5**, on top of the inheritance list in the DONE block:

1. `mergeTemplate` throws `TemplateError` from three bounds, and never a `RangeError`.
   **This was false when it was written** -- the parser still had one, from the spread
   in its unwind; see round 2, finding 2.
2. A template's links may be fragments only -- not `data:`, not `mailto:`, not `tel:`.
   The `mailto:`/`tel:` refusal is a deferred capability with a two-line restore path,
   not a hazard; the note is at `isPermittedUrl`.
3. Merge fields in a `<style>` block are left unsubstituted. In a `style` attribute
   they are substituted and the attribute survives.

##### TASK 3 REVIEW ROUND 2 — S2 again in different clothing, and a RangeError I fixed in one function and left in the other

Commits `c534062`, `7f28dd2`. CI run **33225086394**, tip `7f28dd2`, both jobs green:
**2188 tests, 0 skipped**. On the server: 2150 passed / 38 skipped.

The security core held under everything the round could construct -- the file read
tried through the `<style>` region hole, through both merge orders, through
`image-set`, through six URL positions, against the real renderer: nothing reached a
fetch. What it broke was, again, the claim that the merge is bounded.

**1. THE BUDGET COUNTED STEPS, NOT WORK, AND ONE STEP HAD NO CEILING.** `lookup` ran
`path.split(".")` on every field visit, so the cost of a step was linear in the path's
length and a 1,000,000-step budget bought an unbounded amount of it. Three
`{{#lines}}` around one field, 130 line items:

| path segments | template | before | after |
|---|---|---|---|
| 1 | 70 B | 60 ms | **99 ms** |
| 5,000 | 10 KB | **31 s** | **94 ms** |
| 20,000 | 39 KB | **139 s** | **79 ms** |

Flat in path length, which is the property. `body_html` is unbounded `text` with no
length CHECK and renderPdf's 128KB cap applies to prepare's OUTPUT, so a 1MB template
extrapolated to about 55 minutes of frozen event loop -- and it ended in a tidy
`TemplateError`, which is worse than the original runaway because it looks handled.

**THE EVIDENCE WAS IN MY OWN COMMENT AND I READ IT AS NOISE.** Round 1 recorded
"depths 6, 9, 12 and 20 now stop in 50-79ms, and a body holding one unknown field
stops in 288-329ms (the same steps, more lookup per step)". A 5x swing at an identical
step count is exactly the shape of an unbounded per-step cost. The paths are split
once at parse time now, into the node.

**2. `parse()` THREW A RAW `RangeError`, FROM THE TYPO THIS MODULE PROMISES IS SAFE.**
The unwind did `current().push(...frame.body)`, and V8 stops at about 124,000
arguments: `"{{#lines}}" + "{{a}}x"` repeated 62,153 times -- a 364KB template with a
missing closer -- threw "Maximum call stack size exceeded" out of the parser before
any of the three bounds could see it. S3 fixed this exact failure class in `render`
one round ago and left it here, which falsified round 1's "throws `TemplateError` from
three bounds, and never a `RangeError`" -- the sentence Task 4's route is written
against. It is a loop now, and the case merges in 52ms.

**3. THE `<style>` REGION RULE ERRED IN THE DIRECTION I HAD WRITTEN OFF AS
IMPOSSIBLE.** `cssRegions` ended a region at `indexOf("</style")`, but HTML ends raw
text only at `</style` followed by `>`, `/` or whitespace. So `</styles>` was text to
the parser and end-of-region here, and a merge field after it went back into live CSS.
The same loose needle in `sanitizeDocumentHtml`'s fail-closed check meant one
`</style`-prefixed token anywhere in a stylesheet silently deleted the ENTIRE `<style>`
element. Both use `endsRawText` now, and the comment that called this direction
unreachable is corrected in place.

Not a file read -- the reviewer confirmed `url(file://)` is still removed and
`image-set` stays inert -- but the module's design is not to rest on one layer, and
there it did.

**THE FOUR SMALLER ONES.**

- **5: a missing budget hung CI rather than failing it**, because every depth in the
  non-emitting table was astronomically over budget. Depth 5 and 6 are in the table
  now: over budget with the bound, 72ms and 1.5s without it, so the mutation fails by
  name. The same trap caught the per-step fix -- reverting it made three cases take
  139s each and looked like a hang -- so those tests now assert ELAPSED TIME inside
  the case ("a step must cost a bounded amount") rather than leaving it to a timeout
  that cannot fire while synchronous code is running.
- **6: the URL position defaulted to the permissive one.** `lower === "href" ? "link"
  : "fetch"` meant every URL attribute except literal `href` got `data:` permission,
  so adding `xlink:href` to an element's allowlist would have granted `data:` on a
  link without anybody choosing it. `FETCH_ATTRIBUTES` is enumerated now and anything
  unnamed is a link. Also corrected: the comment credited this guard for `srcset`,
  where sanitize-html's own candidate-list parser is what handles the multi-candidate
  case.
- **7: EVERY FILLED QUOTE OF SIX LINES OR MORE SHIPPED A STRANDED PAGE.** Measured on
  the seeded template as it stood: one page at 0, 2 and 4 line items, two pages from
  six, with page two carrying nothing but the IBAN, VAT and registration lines. The
  spacing is tightened (line-height, the logo box, the table padding, and `.foot`'s
  12mm top margin down to 7mm) and `.foot` gets `page-break-inside: avoid`:

  | line items | filled, before | filled, after | empty, after |
  |---|---|---|---|
  | 0-4 | 1 page | 1 page | 1 page |
  | 6, 8 | **2 pages** | **1 page** | 1 page |
  | 10-16 | 2 pages | 2 pages | 1 page |
  | 20 | 2 pages | 2 pages | 2 pages |

  A filled eight-line quote is 4,101 chars of merged HTML and a **one-page 16,117-byte
  PDF** on 57.2 (12,521 on CI's 61.1); the no-logo case is 3,473 chars and 14,381
  bytes. `documents-seed.test.ts` asserts the page count for BOTH now, where it
  asserted only the empty one. What is NOT asserted is that WeasyPrint honours
  `page-break-inside` -- the rule's presence in the seed is guarded, the page counts
  are the evidence.
- **4: the order test's comment claimed a fetch that does not happen.** `&quot;` IS
  decoded and the `url()` IS closed from inside, but the injected declaration is not
  live on 57.2, and in the shipped order the attribute disappears because postcss
  fails to parse the braces -- `sanitizeCss` removes the URL first, but it is not what
  removes the attribute. The test stays as an order-mutation detector and now says so.
  Worth recording: **the reviewer could not construct any payload where the wrong
  order produces a fetch**, because surviving template-time sanitisation means hiding
  behind `data:`, and getting out of a `data:` url() needs a quote break that leaves
  the CSS invalid.
- **8: the step figures were not reproducible from any context in the suite.** They
  were measured against a probe context that no test uses. The seeded template with
  every field filled in is **1,656 steps at 130 line items and 192 at eight**, and the
  headroom assertion moved to `documents-seed.test.ts` where the real template is --
  it had been guarding an ad-hoc 787-step stand-in, half the true figure.

**9: WHAT THE MODULE DOES SILENTLY NOW SAYS SO.** `documentTemplateWarnings(template)`
is exported for Task 5's editor and names three things that render without complaint
and are not what the author meant: a merge field inside a `<style>` block (which is
left unresolved, and `{{org.brandColour}}` is a reasonable thing to write), a `<style>`
that is never closed (including one inside an HTML comment, which swallows every field
after it), and an unclosed block or a closer that closes nothing. It cannot throw --
a template being edited is half-written by definition.

**A narrow allowance for CSS fields is NOT implemented, and it is a decision rather
than a patch.** Substituting into CSS safely needs CSS escaping AND a shape to check
the value against -- a colour, a length -- which is a validated-field feature rather
than a merge feature. The warning says what did not happen; the allowance is Task 5's
to ask for.

**MUTATIONS FOR THIS ROUND**, all on the server:

| mutation | result |
|---|---|
| the path split back on every visit | 2 fail, named by the elapsed assertion (and it takes 139s to say so) |
| the spread back in the parser's unwind | 1 fails |
| `href` back in the fetch set | 1 fails |
| the raw-text terminator ignored in the region scan | 1 fails |
| the fail-closed needle without its terminator | 1 fails |
| the unclosed-block warning removed | 1 fails |

**One unrelated red run, recorded because the plan already carries its cousin.** The
first full-suite run of this round failed `mail-sync.test.ts`'s exponential-backoff
case; the file passes alone and the suite passed on re-run, and CI has been green
throughout. That is another data point for the open finding in `db5d968` -- ten server
runs, two conditions, no reproduction -- and not one of the three budgets it names.

---

### Task 4: Issuing a quote — one transaction, and the immutability proof

> **TWO THINGS TASK 1 MEASURED THAT THIS TASK HAS TO HONOUR.** Both live here rather
> than only in Task 1's retrospective, because this is where they get implemented.
>
> **1. Concurrency must be limited to THREE renders.** `manifest.toml` declares
> `ram.runtime = "900M"` on the arithmetic 400M (Node) + 3 x 157MB (a render at the
> 128KB input cap, worst shape measured), and that declaration is only true if
> something enforces the three. Nothing does yet: `documents-render.ts` exports no
> bound and the transaction in this task is what will run them. The server is 3819MB
> with **no swap**, so exceeding it is an OOM kill rather than a slowdown.
> `ram.runtime` cannot save you -- YunoHost sets no cgroup from it and does not
> evaluate it at install, so it is documentation. **The input cap is the lever that
> makes any concurrency number achievable**; if you raise one, recompute the other.
>
> **2. The immutability test must compare STORED bytes and must never re-render.**
> Three renders of identical input on one WeasyPrint gave 6899, 6899 and 6898 bytes.
> A re-render-and-diff test would fail for reasons that have nothing to do with
> immutability -- which is the same fact the spec's "re-rendering is not offered"
> decision already rests on.

**Files:**
- Create: `packages/api/src/services/documents-number.ts`, `documents-number.test.ts`
- Create: `packages/api/src/services/documents.ts`, `documents.test.ts`
- Create: `packages/api/src/services/org-profile.ts`
- Create: `packages/api/src/routes/documents.ts`
- Modify: `packages/api/src/routes/index.ts` (register the route)

- [ ] **Step 1: Write the failing number tests**

`packages/api/src/services/documents-number.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatDocumentNumber } from "./documents-number.ts";

describe("formatDocumentNumber", () => {
  it("formats a quote number with a four-digit sequence", () => {
    expect(formatDocumentNumber("quote", 2026, 1)).toBe("QUO-2026-0001");
  });

  it("does not truncate past four digits", () => {
    expect(formatDocumentNumber("quote", 2026, 12345)).toBe("QUO-2026-12345");
  });
});
```

- [ ] **Step 2: Run it, watch it fail, implement**

`packages/api/src/services/documents-number.ts`:

```ts
import { sql } from "drizzle-orm";
import { documentNumberSequences } from "../db/schema.ts";
import type { Database } from "../db/client.ts";

const PREFIX: Record<string, string> = { quote: "QUO" };

export function formatDocumentNumber(type: string, year: number, value: number): string {
  return `${PREFIX[type] ?? "DOC"}-${String(year)}-${String(value).padStart(4, "0")}`;
}

/**
 * Take the next number for (type, year). MUST run inside the caller's transaction:
 * the whole point of a table over a SEQUENCE is that a failed render rolls this back
 * and leaves no hole in the numbering.
 *
 * The ON CONFLICT update takes a row lock, so two quotes of the same type and year
 * serialise here. That is bounded by the render timeout and is the behaviour you
 * want -- consecutive numbers are consecutive.
 */
export async function allocateNumber(tx: Database, type: string, year: number): Promise<string> {
  const [row] = await tx.insert(documentNumberSequences)
    .values({ type, year, lastValue: 1 })
    .onConflictDoUpdate({
      target: [documentNumberSequences.type, documentNumberSequences.year],
      set: { lastValue: sql`${documentNumberSequences.lastValue} + 1` },
    })
    .returning({ lastValue: documentNumberSequences.lastValue });
  return formatDocumentNumber(type, year, row.lastValue);
}
```

Run: `npx vitest run packages/api/src/services/documents-number.test.ts` — expect PASS.

- [ ] **Step 3: Write the failing service tests — including the immutability proof**

`packages/api/src/services/documents.test.ts`. Follow the existing DB-test harness in
`packages/api/src/services/deals.test.ts` for `handle` setup and fixtures.

```ts
import { describe, expect, it } from "vitest";
import { issueQuote, listDocuments } from "./documents.ts";
import { weasyprintAvailable } from "./documents-render.ts";

const itRender = (await weasyprintAvailable()) ? it : it.skip;

describe("issueQuote", () => {
  itRender("stores a numbered PDF against the deal", async () => {
    const { handle, dealId, userId } = await seedDeal();
    const doc = await issueQuote(handle.db, handle.config, userId, {
      dealId, currency: "EUR", issueDate: "2026-08-28",
      recipientName: "Acme", recipientAddress: "2 Low St", notes: "", terms: "",
      lines: [{ description: "Widget", qtyMilli: 2000, unitPriceCents: 5000, taxRateBp: 2100 }],
    });
    expect(doc.number).toBe("QUO-2026-0001");
    expect(doc.totalCents).toBe(12_100);
    const files = await listFilesForDeal(handle.db, dealId);
    expect(files).toHaveLength(1);
    expect(files[0].mime).toBe("application/pdf");
  });

  itRender("gives the second quote of the year the next number", async () => {
    const { handle, dealId, userId } = await seedDeal();
    await issueQuote(handle.db, handle.config, userId, quoteInput(dealId));
    const second = await issueQuote(handle.db, handle.config, userId, quoteInput(dealId));
    expect(second.number).toBe("QUO-2026-0002");
  });

  // THE PHASE'S CENTRAL CLAIM. Everything else is a convenience; this is the promise.
  itRender("leaves an issued quote untouched when the world moves on", async () => {
    const { handle, dealId, userId, companyId } = await seedDeal();
    const before = await issueQuote(handle.db, handle.config, userId, quoteInput(dealId));
    const pdfBefore = await readStoredPdf(handle, before);

    await handle.db.update(companies).set({ name: "Renamed Ltd" }).where(eq(companies.id, companyId));
    await handle.db.update(deals).set({ valueCents: 999_999 }).where(eq(deals.id, dealId));
    await handle.db.update(documentTemplates).set({ bodyHtml: "<p>totally different</p>" })
      .where(eq(documentTemplates.type, "quote"));

    const [after] = await listDocuments(handle.db, dealId);
    expect(after).toEqual(before);
    expect(await readStoredPdf(handle, after)).toEqual(pdfBefore);
  });

  itRender("spends no number when the render fails", async () => {
    const { handle, dealId, userId } = await seedDeal();
    await handle.db.update(documentTemplates)
      // An unclosed construct WeasyPrint will not accept, forcing a non-zero exit.
      .set({ bodyHtml: "<style>@page { size: !!! }</style>" })
      .where(eq(documentTemplates.type, "quote"));
    await expect(issueQuote(handle.db, handle.config, userId, quoteInput(dealId))).rejects.toThrow();

    await handle.db.update(documentTemplates).set({ bodyHtml: "<p>{{document.number}}</p>" })
      .where(eq(documentTemplates.type, "quote"));
    const recovered = await issueQuote(handle.db, handle.config, userId, quoteInput(dealId));
    // Not 0002: the failed attempt rolled its allocation back.
    expect(recovered.number).toBe("QUO-2026-0001");
  });
});
```

- [ ] **Step 4: Implement the orchestration**

`packages/api/src/services/documents.ts` — the shape, which you fill in against the
existing service conventions (`deals.ts` is the closest model for transaction use):

```ts
/**
 * Issue a quote. ONE transaction: allocate the number, render, store the blob,
 * insert the file, insert the document and its lines.
 *
 * The order is deliberate and the transaction is what makes it safe. The number has
 * to exist before rendering because it is PRINTED on the page; a failed render must
 * not spend it. A table-backed counter rolls back where nextval() would not -- see
 * documents-number.ts.
 *
 * The blob is written to disk INSIDE the transaction and is the one part that cannot
 * roll back. That is deliberate and harmless: blobs are content-addressed by sha256,
 * an orphan is unreferenced bytes rather than a visible document, and the alternative
 * (commit, then write, then hope) can leave a documents row whose file does not
 * exist -- a broken record instead of a wasted one.
 */
export async function issueQuote(db, config, actorId, input): Promise<DocumentDto> {
  return await db.transaction(async (tx) => {
    const year = Number(input.issueDate.slice(0, 4));
    const number = await allocateNumber(tx, "quote", year);
    const totals = documentTotals(input.lines);
    const html = sanitizeDocumentHtml(mergeTemplate(await loadTemplate(tx, "quote"), buildContext(...)));
    const pdf = await renderPdf(html);
    const { sha256, sizeBytes } = await saveBlob(config.dataDir, Readable.from(pdf));
    const file = await attachFile(tx, actorId, { originalName: `${number}.pdf`, mime: "application/pdf", sizeBytes, sha256, dealId: input.dealId });
    // ... insert documents row + line items, return the DTO
  });
}
```

- [ ] **Step 5: Run the service tests**

Run: `npx vitest run packages/api/src/services/documents.test.ts`
Expected: PASS locally with render tests skipped if you have no binary; run them on the
server to prove them for real, exactly as in Task 1 Step 5.

- [ ] **Step 5a: Gate the input BEFORE anything spawns — Task 2 left this deliberately**

`money.ts` bounds `qtyMilli` and `taxRateBp` to the int4 range its columns can hold, so
the SV-1 failure (compute, render, then die on the insert) cannot happen for magnitude.
It does NOT enforce the business bounds. THREE constraints are gates this task owns, not
two — `qty_milli >= 0`, `unit_price_cents >= 0` and `tax_rate_bp BETWEEN 0 AND 10000` —
and the quality review reproduced all three end to end on a real database as 23514s
raised AFTER a successful render. `money.ts` keeps a wider domain than all of them on
purpose — `divideRoundHalfUp` has a negative branch for a future credit
note.

**So a negative quantity, or a 150% tax rate, still computes, still renders a PDF, and
then dies on the insert as a 23514 instead of a 22003.** Same defect, different error
code. The repo's split is "Zod is the gate, the CHECK is the backstop", and this task
owns the gate: validate every line item against the same bounds the constraints enforce,
and reject before the render is spawned.

- [ ] **Step 5b: Make the merge contract a contract, not a coincidence**

`schema.test.ts`'s `SEEDED_FIELDS` equality compares the seeded template's tokens
against a literal list sitting beside it in the same file. **Nothing connects either
side to `buildContext`.** Supply `document.subTotal` for the template's
`{{document.subtotal}}` and that test stays green while the PDF prints a blank where a
total should be — which is the single most expensive kind of bug in this phase, because
it is invisible until someone reads a quote.

Add the test that closes it: assert the key set `buildContext` actually produces against
the same token list the template is checked against. `org.*` and `document.*` keys must
match exactly; the line-scope keys are checked against a line object. Extra context keys
are harmless (the requirement is "at least"), missing ones are not — so assert
containment in that direction and say so in the test's name.

- [ ] **Step 6: Add the routes**

`packages/api/src/routes/documents.ts`: `POST /api/deals/:dealId/documents` (issue),
`GET /api/deals/:dealId/documents` (list), and the org profile's `GET`/`PUT
/api/org-profile`. Download reuses the existing `GET /api/files/:id` — do not write a
second download path. Register in `packages/api/src/routes/index.ts` beside the others.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/services/documents-number.ts packages/api/src/services/documents-number.test.ts packages/api/src/services/documents.ts packages/api/src/services/documents.test.ts packages/api/src/services/org-profile.ts packages/api/src/routes/documents.ts packages/api/src/routes/index.ts
git commit -m "feat(api): issue a quote in one transaction, and prove it never changes after"
```

#### TASK 4 DONE — the failure paths run without the binary, and the plan's fourth failure no longer exists

Commit `8e232b6`. CI run **33227608626**, tip `8e232b6`, both jobs green: **2257 tests,
0 skipped**. On the server: 2219 passed / 38 skipped. No migration; nothing in
`schema.ts` or `drizzle/` was touched.

The steps above are left as written so the corrections are legible.

**1. THE TRANSACTION'S FINAL ORDER, which is one step longer than Step 4's sketch.**
Read the deal, read the template, read the issuer profile and inline its logo,
**then** allocate the number, merge, render, write the blob, insert the file, insert
the document and its lines.

The three reads moved AHEAD of the allocation deliberately. The `ON CONFLICT` takes a
row lock held to commit, and there is no reason to read three more rows inside it; the
lock now covers the merge, the render and the inserts, about a second of which
~600-700ms is the render. Everything that can fail with the caller's fault attached --
the input gate, an unknown or archived deal, a missing template -- fails before the
allocation, so those cases spend no number and never reach a subprocess. Each is
asserted by a marker file the stub renderer touches: its ABSENCE is the assertion,
because "the request was refused" and "the request was refused in time" are different
claims and only one of them is the design.

**Rollback is proved three ways, and two of them need no binary.** A render that exits
5 leaves no sequence row, no `files` row, no document, and the next quote is
`QUO-2026-0001` rather than 0002 -- which is exactly what `nextval()` could not have
given. A template that busts `mergeTemplate`'s depth bound rolls the allocation back
before the spawn. And the blob's orphan is pinned rather than tolerated in silence: a
colliding number makes the INSERT fail with the PDF already written, and the test
asserts the store grew by one file while the database gained nothing that refers to
it.

**2. `attachFile` IS REUSED, WITH ONE HONEST COST.** It is the only place a `files`
row is created, it stamps the `file_attached` timeline entry, and it re-checks the
deal -- so `issueQuote` calls it with `tx` (drizzle turns its inner transaction into a
savepoint). The cost is that its `publish()` fires before the OUTER transaction
commits, so a rollback leaves one spurious SSE invalidation behind. Clients refetch
and see nothing, which is why this was preferred to a second file-insert path that
would drift from the first.

**No new `events` verb.** `file_attached` already puts "QUO-2026-0001.pdf" on the
deal's timeline, and a `document_issued` verb would mean widening
`events_verb_valid` in a migration for a second entry about the same act.

**3. THE GATE IS IN `@conduit/shared` AND IS ENFORCED TWICE.** `issueQuoteInputSchema`
bounds all three CHECK constraints -- `qty_milli >= 0`, `unit_price_cents >= 0`,
`tax_rate_bp BETWEEN 0 AND 10000` -- plus the int4 ceiling `money.ts` already knew
about, a 1-130 line count and a 500-character description (Task 2's budget
arithmetic, both halves, since neither bounds anything alone).

It lives in shared rather than in the route because Task 5's form needs the same
bounds, and it is re-parsed inside `issueQuote` because the route is not the only
caller: a direct service call is exactly how the three 23514s were reproduced.
Removing the service-side parse fails **7 tests**; the route-side parse alone would
have left every one of them green.

**THE FOURTH FAILURE PATH THE PLAN NAMES DOES NOT EXIST ANY MORE, and the real one is
next door.** The hand-off warned that a total between 7,036,874,417,766,401 and 2^53-1
"throws in `formatMoneyCents`". It did, one round ago; Task 2's review round 2 (F2)
removed that ceiling and rebuilt the decimal with BigInt, and the function now cannot
throw for any input. Verified against the code rather than the prose, and pinned: a
quote whose total is exactly 7,036,874,417,766,401 is issued, stored and formatted
exactly.

The failure that IS real is one line up. Every field can be in range while the
ARITHMETIC over them is not -- 130 lines of 2,147,483.647 units at `MAX_SAFE_INTEGER`
cents pass all three CHECKs and both representability constraints, and
`documentTotals` throws a plain `Error`. That is now a `superRefine` on the same
schema, so it is a 400 with a sentence rather than a 500. It costs one extra pass of
the arithmetic the service was about to run anyway, and it happens before the render
either way -- so this was about what the caller is told, not about what is wasted.

**4. THE MERGE CONTRACT IS NOW A CONTRACT, and the connection runs through the
template rather than through a list.** `schema.test.ts` compares the seeded template's
tokens to a literal list beside it; `test/seed-template.ts` reads the merge PATHS out
of the migration itself, and `documents.test.ts` asserts `buildContext`'s actual key
set contains every one of them. Containment, not equality, and in that direction: an
extra context key prints nothing, a missing one prints a blank on a page nobody
notices until a customer reads it.

Renaming `document.subtotal` to `document.subTotal` -- the exact defect the plan
names -- **fails 3 tests**. Before this task it failed none.

The third of those three is the one worth keeping: it merges the REAL seeded template
through the real resolver with a filled context and looks for the values themselves
("QUO-2026-0001", "11,000.00", "21%"), because a complete key set and a template that
prints nothing are compatible states. The anti-vacuity guard matters too -- the path
reader is asserted to find more than 20 paths including `document.subtotal`, or the
containment check would pass against an empty list.

**5. MOST OF THIS SUITE RUNS WITHOUT WEASYPRINT, AND THE IMMUTABILITY TEST IS THE
REASON, not a convenience.** A stub `python3` on PATH (Task 1's mechanism, moved to
`test/python-stub.ts` now that two files want it) emits `%PDF-` followed by **eight
random bytes per invocation**.

With a constant-output stub, "the stored PDF is byte-identical after the world moves
on" passes for code that re-renders on every read: the assertion would be about the
stub. Varying bytes make it a claim -- identical bytes can only mean nothing
re-rendered -- and they mirror reality, since the real renderer is not reproducible
either (Task 1: 6899, 6899, 6898). The control for that control is its own test: two
quotes of the same input must produce DIFFERENT stored bytes.

**The three edits are asserted to have landed.** `truncateAll()` destroys the seeded
template, so `update(documentTemplates)` written the obvious way updates zero rows and
the "changed" template is the same template -- the test proves nothing while looking
like the most important test in the repo. Every test in the file seeds its own
template from the migration, and the immutability test checks `.returning()` has
length 1 for all three edits.

**Step 3's suggested failure template was not used.** `<style>@page { size: !!! }</style>`
does not fail a render -- WeasyPrint ignores CSS it cannot parse -- so a stub that
exits 5 is both deterministic and available on a machine with no binary.

**6. CONCURRENCY IS BOUNDED AT THREE, INSIDE `renderPdf`.** `RENDER_MAX_CONCURRENCY`
with a FIFO semaphore, acquired after the input cap (an oversized document is refused
outright rather than queued for a slot it would waste) and released in a `finally`.

It is in the renderer rather than in the issuing transaction because the budget is a
property of the process, not of quotes: Task 5's template preview and any future
document type need the same bound, and a limit a caller has to remember is a limit
that holds until somebody adds a call site. ~~On the issuing path it is never
contended today -- the number sequence's row lock already serialises quotes of one
type and year.~~ **FALSE, and measured false in review round 1**: the year comes from
the caller's issue date, so two quotes dated in different years render side by side.
The queue is reachable from the issuing path, which is why the wait is now bounded.

Measured from the CHILDREN, not from a counter inside the module: each stub records
how many copies of itself were running when it started. Six renders at once reach
exactly 3. **Removing the acquire fails it; tightening it to 1 fails it too**, which
is why the test asserts a floor as well as a ceiling -- "never more than three" is
satisfied by a bound of one, and that would be a different bug. A fourth test asserts
`400 + 3 x 157 <= manifest.toml`'s declared `ram.runtime`, so the code and the
declaration cannot drift apart.

**7. THREE THINGS THE PLAN'S ROUTE SPEC HAD SLIGHTLY WRONG.** The download route is
`GET /api/files/:id/download`, not `/api/files/:id` (still reused; no second path was
written). The param is `:id` rather than `:dealId`, because eight `/api/deals/:id/*`
routes already exist and find-my-way refuses two parameter names in one path position
-- the URL is identical. And the currency is taken from the DEAL rather than from the
submission, as `documents_currency_format`'s comment says it must be; Step 3's sketch
put it in the input.

**Four failures answer 4xx rather than 500**, each mapped in `routes/documents.ts` so
`helpers.ts` stays general: the input gate and a rejected logo are 400 `validation`; a
deleted template is 409 `template_missing`; `TemplateError` is 422 `template_error`;
`RenderError` is 413 `too_large` for the input cap and 422 `render_failed` otherwise.
**`RenderError.detail` never reaches the wire** -- it is the child's stderr and can
name server paths -- so the message is this codebase's own short phrase, asserted as
such.

**8. THE LOGO HAS A CEILING AND A BLOCKER.** `MAX_LOGO_BYTES` is 32KB, enforced in
`saveOrgProfile` where the REFERENCE is stored rather than only at Task 5's upload:
`PUT /api/org-profile` takes a file id, files are immutable once stored, and the
alternative is a logo accepted in Settings whose defect surfaces weeks later as a
quote that will not render. The mime is checked too, and SVG is deliberately excluded
-- it is a document format with its own URL-bearing elements, arriving inside a
`data:` URI where neither the sanitiser nor the renderer's fetcher looks.

**THE BLOCKER IS TASK 5'S AND IT IS REAL.** `files_exactly_one_entity` requires every
`files` row to belong to exactly one company, contact, deal or project -- and an
issuer's logo belongs to none of them. `org_profile.logo_file_id` references
`files.id`, so there is no legal row for a logo to be. Both suites here attach their
logo to a company to get a file id at all, and say so at the line. ~~Nothing in this
task can fix it~~ -- **the coordinator ruled it into a `data:` URI column on
`org_profile` and review round 1 implemented it, so `MAX_LOGO_BYTES` now bounds a
value the profile holds directly and there is no `files` row involved at all.**

**The 1x1 transparent placeholder Task 2 suggested is NOT implemented, and should not
be.** That note predates Task 3's re-seed, which wraps the logo in
`{{#org.logoDataUri}}`; an empty string now means no `<img>` at all, which is a plain
letterhead. A placeholder would put the element back.

**9. THE TWO FORMATTERS TASK 2 LEFT HOMELESS LANDED BESIDE `formatMoneyCents`.**
`formatQtyMilli` (1500 -> "1.5") and `formatTaxRateBp` (2100 -> "21%"), both exact
from the integer via BigInt, both defaulting to `MONEY_LOCALE`, neither able to throw
-- the same three rules that file already enforces, for the same reason: the form's
quantity column and the printed page must not disagree. 2,147,483.647 is exact at the
top of the int4 column, which a `/1000` divide is not.

**10. THE FILLED RENDER TASK 2 DEFERRED NOW HAPPENS HERE.** Two gated tests take the
real seeded template through the real `buildContext` and the real binary: a filled
eight-line quote with a `data:` logo is **one page with an image XObject**, and the
new-install case -- nothing filled in, no logo -- is **one page with none**. Both ran
on the server's 57.2 and on CI's 61.1.

**MUTATIONS, all run on the server.**

| mutation | fails |
|---|---|
| `document.subtotal` renamed to `document.subTotal` | **3 of 32** |
| the service-side input gate removed (route parse kept) | **7 of 32** |
| the render slot never acquired | 1 |
| `RENDER_MAX_CONCURRENCY` tightened to 1 | 2 |

**WHAT TASK 5 INHERITS.**

1. **`issueQuoteInputSchema`, `documentSchema`, `orgProfileSchema` and
   `DOCUMENT_MAX_LINES`/`DOCUMENT_MAX_DESCRIPTION_CHARS` are in `@conduit/shared`.**
   The form must parse its text into integer units and reject what does not parse
   before calling `documentTotals` (Task 2's contract), and the schema is what says
   what "in range" means on both sides. **The two constants are 60 and 250, not the
   130 and 500 this task shipped -- see review round 1, SV-1 -- and there is a byte
   budget beside them the editor should show.**
2. ~~**The logo blocker above.** A logo upload has nowhere legal to put its `files`
   row.~~ **RESOLVED in review round 1**: the logo is a `data:` URI column on
   `org_profile` and there is no `files` row to place.
3. **`formatQtyMilli` and `formatTaxRateBp`** are exported from the barrel, so the
   running total, the quantity column and the rate column are the same code as the
   PDF's.
4. **`GET /api/deals/:id/documents` returns newest first with lines in position
   order; the PDF downloads from `GET /api/files/:fileId/download`.** There is no
   update or delete route, and that is the phase's claim rather than an omission.
5. ~~**`documentTemplateWarnings` is still unused.** Task 3 exported it for the
   template editor; nothing in this task had a surface for it.~~ **The surface it was
   waiting for had no API either, which this note missed. Review round 1 adds
   `GET`/`PUT /api/document-templates/:type`, and the response carries the
   warnings.**

##### THE INTERMITTENT UNIT FAILURE — MEASURED, AND THE NAMED MECHANISM IS FALSIFIED

The full suite failed once during this task, on `mail-sync.test.ts`'s
exponential-backoff case -- the same test Task 3 round 2 saw. The server was free, so
the experiment the plan asks for was run.

**The hypothesis as written cannot be the mechanism.** It names `waitFor`'s 10-second
wall-clock deadline and the `timed out waiting for` label. `vitest.config.ts` sets no
`testTimeout`, so the default 5000ms fires first, always -- **that label is
unreachable**, and every sighting's message is vitest's own `Test timed out in
5000ms`. The plan's "fails with a label rather than an assertion, which is why the
earlier sightings produced no useful name" is therefore wrong about the label, though
right that the message is uninformative.

**Nor is it a slowdown.** The test's normal cost is **180-240ms**, which is 4% of its
budget. When it fails it exceeds 5000ms: a 25x blowout, not a margin being eaten. It
wedges.

**Measured, `mail-sync.test.ts` alone, twelve runs each:**

| condition | failures |
|---|---|
| idle server | **1 of 12** |
| a second vitest process on the same box | **8 of 12** |

So contention is a strong amplifier -- and the contending load was another vitest,
which is CPU *and* the shared `conduit_test` database at once, matching "another
agent's work on the same box". But an idle box still loses one run in twelve, so
contention is not required and there is a race underneath it. The test drives eight
backoff cycles through `ManualClock.fire()`, and `wait(ms <= 0)` resolves without
registering a pending entry -- so a `waitFor(() => clock.pendingCount() > 0)` that
arrives after the loop has taken that fast path waits forever. That is a hypothesis
from reading, not a measurement, and it is the shape worth testing next.

**The advice not to raise the timeout stands, and is now stronger**: at 4% of budget,
a longer timeout only makes the wedge take longer to report.

##### TASK 4 REVIEW ROUND 1 — a gate that promised more than the renderer delivers, and an FK that could never be satisfied

Commit `abdd0ec`. The security core and the immutability claim held: no update or
delete path, recipient snapshotted, totals read back rather than recomputed, and the
no-gaps property re-derived by racing two real Postgres sessions. All four mutation
counts reproduced. Six findings landed on top.

**SV-1: THE ADVERTISED MAXIMUM WAS NOT DELIVERABLE, AND MY COMMENT'S ARITHMETIC WAS
WRONG TWICE.** 130 lines x 500 characters was documented as sized against renderPdf's
128KB input cap. Measured end to end against the real template, `buildContext` and
`prepareDocumentHtml`:

| gate-legal input | merged |
|---|---|
| 130 x 500 ASCII, maxed notes/terms/address/names, maxed logo | **141,764 B** |
| 130 x 500 accented, no logo | **162,699 B** |
| 130 x 500 ASCII, no logo, short notes | 98,005 B |

Two errors compounded. A line was costed at "about 120 bytes" and measures **145**.
And the budget subtracted only the template and the logo -- it never accounted for
`notes` (5000), `terms` (5000), `recipientAddress` (2000) or the two 200-character
names, all permitted by the same schema. Task 5's editor would have offered a quote
the server refuses, at roughly half the advertised count for a Dutch or French one.

**Everything is measured now, and the figures are in the code rather than in prose.**
On the seeded template, as merged and sanitised UTF-8:

| | |
|---|---|
| the template with an empty context | 2,211 B |
| a maxed org profile INCLUDING a maxed logo | +47,320 B |
| maxed notes/terms/address/names (ASCII) | +12,486 B |
| one more line item, short description | +145 B |
| one more ASCII character of description | +1 B |

**Escaping is measured too, and it is not what it looks like.** `&` costs 5 bytes and
`<` and `>` cost 4, because substitution escapes them and the sanitiser leaves them
escaped. **`"` and `'` cost 1** -- escaped on the way in and re-serialised bare in text
position. A budget counting string length would under-count an ampersand-heavy quote
five to one, and one assuming quotes were expensive would over-count.

**The constants are now 60 lines x 250 characters**, which is what survives the worst
case the review named: every optional field maxed, a maxed logo, and ACCENTED text
throughout. That merges to ~113KB. A permanent test builds exactly that quote and
asserts it fits, so the pair can never drift from the renderer again.

**AND A BYTE BUDGET, BECAUSE CHARACTER COUNTS CANNOT BOUND BYTES.** Sizing the
constants for the true worst character (a 3-byte CJK glyph, or a 5-byte `&`) would
have meant about 35 lines, which is not a quote system. So `documentContentBytes`
counts the actual submission -- escaping included, exact for any script -- against
`DOCUMENT_CONTENT_BUDGET_BYTES` (66,688 = the 128KB cap minus a 16KB template
allowance minus a 48KB issuer reserve). A quote inside every field cap and over the
total is refused by the GATE with a sentence about the budget, not by a 413 naming a
byte count. Task 5's editor computes the same function to show what is left.

**Its conservatism has one named exception and the 413 stays for it**: the gate counts
a value once, and a template printing `{{document.notes}}` forty times prints it
forty times. There is a route test for that shape -- and it is a 413 only between
128KB and 512K, because above that `mergeTemplate`'s own output bound throws first
and the answer is a 422.

**SV-2: A FOURTH POST-RENDER 500, GATED IN ONE LINE.** `z.iso.date()` accepts
`0000-01-01` and **Postgres has no year zero**, so that quote computed, allocated a
number, RENDERED, wrote the blob and died on the INSERT with `22008` -- a bare Error
no domain mapping catches, through the public route. Same shape as the three CHECK
constraints, third error code. `documentDateSchema` floors both dates at a four-digit
year. `formatDocumentNumber` pads the year too, so the `QUO-0-0001` that quote would
have carried is unreachable twice over.

**O-1: THE SEMAPHORE IS REACHABLE FROM THE ISSUING PATH, AND TWO OF MY COMMENTS SAID
IT WAS NOT.** The year comes from the caller's issue date, so quotes dated in
different years take different sequence rows, different locks, and render side by
side. Measured from the children, and now a permanent pair of tests: **two quotes in
different years reach 2 concurrent renders; two in the same year reach 1.** The second
is the control that says what the row lock does do.

Worse, the companion claim that the lock hold is "bounded by renderPdf's 20s timeout"
was false in a way that mattered: **the queue wait precedes the timeout and was
itself unbounded.** With ten pooled connections and ten distinct years, ten
transactions could hold their row locks and their connections indefinitely while three
render -- an authenticated-user stall of the whole API. `RENDER_QUEUE_TIMEOUT_MS` is
10s, so the bound is now 10s + 20s and a saturated renderer answers **503
`renderer_busy`** rather than hanging. A timed-out waiter removes itself from the
queue; leaving it would hand a slot to nobody and lose it permanently, which has its
own test.

**FIFO WAS ONLY A COMMENT, AND MY FIRST TEST FOR IT WAS FLAKY IN THE SAME WAY THE
CODE UNDER TEST WAS NOT.** It read the order three queued children appended to a log,
which measures which PROCESS won a start-up race rather than which caller was granted
a slot: two failures in five runs, "DFE" where the grants had been in order. The
holders now occupy the three slots for staggered durations so only one slot frees at
a time and the grants are 100ms apart. Six consecutive clean runs; the LIFO mutation
answers "FED".

**O-3: THE LOGO MOVED OUT OF `files` AND INTO A `data:` URI COLUMN**, per the
coordinator's ruling. The old `logo_file_id uuid REFERENCES files(id)` could never be
satisfied: `files_exactly_one_entity` requires every file to belong to exactly one
company, contact, deal or project, and an issuer's logo belongs to none of them. Both
suites had been attaching their test logo to an unrelated company to get an id at all.

0009 was REGENERATED (not hand-edited), the journal's `when` and `tag` restored so its
diff is empty, the hand-written index and seed re-appended, and `conduit_test` dropped
and recreated. `orgLogoDataUri` is gone -- the logo arrives with the row, which also
removes a disk read from inside the issuing transaction.

**THE TRAP THE COORDINATOR FLAGGED IS REAL AND THE TEST FOUND ITS OTHER FACE.**
`MAX_LOGO_BYTES` (32,768) bounds the IMAGE; `MAX_LOGO_DATA_URI_CHARS` (43,715 = 4 x
ceil(32768/3) + the longest prefix) bounds the COLUMN. Reusing the first as the second
shrinks the permitted logo to 24KB silently -- that mutation fails 3 tests. But the
converse is what the suite actually caught first: **a 32,768-byte image and a
32,769-byte one produce the SAME 43,692 base64 characters**, differing only in
padding, so the column CHECK cannot tell them apart at all. The decoded-size
arithmetic in `logoDataUriProblem` is the only thing that can, and it is the half that
had to be right.

**A drizzle-kit limitation, recorded because it produced INVALID SQL.** The generator
splits a CHECK expression on `;` with no regard for string literals, so a regex
containing `;base64,` came out truncated mid-literal -- no closing quote, no closing
paren. The shape CHECK uses `\073`, Postgres's octal escape for the same character.
Read the generated migration, not just the schema.

**The merge contract survived untouched**, as predicted: `org.logoDataUri` was already
the path on both sides, so `SEEDED_FIELDS` and the Step 5b key-set test passed without
edits.

**O-2: THE TEMPLATE EDITOR HAD NO API, WHICH IS WHY `documentTemplateWarnings` HAD NO
CALLER.** My own DONE block noted it was unused "because nothing in this task had a
surface for it" without noticing the surface it waits for had nothing to call.
`GET`/`PUT /api/document-templates/:type` now exist, keyed by type (there is one row
per type by unique constraint, and it saves the client a lookup for an id it can
derive). A write is sanitised -- belt to `prepareDocumentHtml`'s braces, so what
Settings shows back is what a quote will use -- refused if it sanitises away to
nothing, and bounded by `MAX_TEMPLATE_CHARS` (16KB, four and a half times the shipped
3,614-character template), which is the template's share of the render budget. The
response carries the warnings.

**O-5, O-6, O-7: the tests.**

- **The immutability claim is now proved in its strong form.** Comparing stored bytes
  does not prove nothing re-rendered -- both reads open the same content-addressed
  path, so a re-render whose output was discarded would pass. The stub renderer counts
  its spawns, and the count is asserted unchanged across the edits. The varying bytes
  stay as the independent second assertion.
- **Three cases a user actually performs are now permanent**: archiving the deal,
  editing the org profile, and raising a second quote. Each asserts the row, the
  stored bytes AND the render count.
- **Worth stating plainly: `documents` stores no issuer snapshot at all.** The PDF
  carries the issuer's name, address, VAT number and logo; the row never held them, so
  a listing can only ever say who a quote went TO. Consistent with "the PDF is the
  artifact, the row is the record" -- and a real limit, because renaming the company
  you trade as makes every historical quote's issuer unrecoverable without opening its
  PDF. The invoice type the spec defers is where that should be solved, alongside the
  recipient's missing VAT number.
- **The key-set test is scope-aware now.** It pooled line-scope names with root ones,
  so a `{{qty}}` used at top level would have counted as supplied while rendering
  empty. `seededTemplatePaths()` returns `{ root, line }` and each is checked against
  its own scope; the split itself is asserted.
- Route-level tests for the 413, the budget 400, the 503 path's constants, and the
  template routes.

**MUTATIONS FOR THIS ROUND**, all on the server:

| mutation | fails |
|---|---|
| the budget check disabled | 3 |
| `MAX_LOGO_DATA_URI_CHARS` set to `MAX_LOGO_BYTES` (the named trap) | 3 |
| the queue timeout made effectively unbounded | 3 |
| the year floor removed | 1 |
| the queue served LIFO | 1 |

---

### Task 5: The UI — the deal's Documents section and the phone-first line editor

**Files:**
- Create: `packages/web/src/components/document-form.tsx`
- Create: `packages/web/src/pages/settings-org.tsx`
- Modify: `packages/web/src/pages/deal-detail.tsx`, `packages/web/src/pages/settings-templates.tsx`

- [ ] **Step 1: Measure the line editor at 390px BEFORE building it**

A four-column table of description, quantity, unit price and tax is the exact shape that
does not fit a phone, and v0.10.0 made "works on a phone" the standard for the whole app
rather than one phase's ambition. Open the running app at 390x664 and measure what a
four-column row actually does at that width. **Report the measurement and your proposed
layout before implementing** — this is the same gate Phase 6's Gantt had, and it exists
because that phase's first answer (a 135px chart) was technically compliant and useless.

The expected answer is stacked cards below the breakpoint — one field per line, a
full-width "Add line" button, and a running total that stays visible while you type —
with the table retained above it. Prove or refute that with a measurement.

- [ ] **Step 2: Build the form with the running total from the shared arithmetic**

`document-form.tsx` imports `documentTotals` from `@conduit/shared` — the SAME function
the server stores with. Do not recompute totals in the component; a second
implementation is a second answer.

**`documentTotals` THROWS on a non-integer or unsafe input — it does not return NaN.**
That is deliberate (Task 2 made it strict so a bad value cannot reach a `bigint` column
silently), and it makes this the most likely way this task ships a visible bug: a user
half-way through typing a quantity gives you `""` or `1.5`, the component calls straight
through, and the throw happens inside render and takes the whole form down through the
error boundary.

Parse and validate at the input boundary, before the call: text to integer units, and a
field that is empty or mid-edit contributes a zero line rather than an exception. The
running total must degrade to a partial figure while someone types, never to a blank
screen. Test the half-typed states explicitly — `""`, `"."`, `"1."`, `"-"`, `"1e5"` —
because they are what a real keyboard produces and none of them is an integer.

- [ ] **Step 3: Add the Documents section to the deal**

List: number, issue date, total, download link (to `/api/files/:id`). Empty state that
says what to do. The "New quote" action opens the form as a full-screen sheet on a
phone, per the v0.10.0 dialog convention.

- [ ] **Step 4: Settings**

`settings-org.tsx` for the issuer profile and logo upload; extend
`settings-templates.tsx` with the quote template editor and **the merge-field list
rendered on the page** — a template language whose fields are documented elsewhere is a
template language nobody uses correctly.

- [ ] **Step 5: Verify, then commit**

Run: `npm test`, `npm run typecheck`, `npm run build`
Expected: green; build clean **with no CSS warning** (a Tailwind v4 trap this repo has
hit twice: a class name spelled in prose is scanned and emitted as invalid CSS).

```bash
git add packages/web/src
git commit -m "feat(web): raise a quote from a deal, with a line editor that works on a phone"
```

---

### Task 6: e2e, and the v1.0.0 release

**Files:**
- Create: `e2e/documents.spec.ts`
- Modify: three `package.json` versions, `manifest.toml`

- [ ] **Step 1: The journey**

Fill in the org profile, open a deal, raise a quote with two line items, assert the
number, assert it appears on the record, download it and assert the response is
`application/pdf` starting `%PDF-`. Then a phone-viewport test of the line editor, using
the `test.use({ ...devices["iPhone 13"] })` pattern **minus `defaultBrowserType`** —
`e2e/mobile.spec.ts` explains at length why that one key is dropped, and a whole spread
moves the file to WebKit, which the e2e job does not install.

- [ ] **Step 2: The 96 existing e2e tests must pass unchanged.** Verify from the diff,
not from a summary: `git diff origin/main..HEAD -- e2e/` should touch only your new file.

- [ ] **Step 3: Release prep**

Bump 1.0.0 in three `package.json`s and `manifest.toml` (`1.0.0~ynh1`), regenerate the
server lockfile (inspect the diff — versions only), and write
`release-notes-v1.0.0.md` and `release-sequence-v1.0.0.md` in the session scratchpad.

**The sequence must carry v0.10.0's corrections**, which were bought expensively:
`gh run list --workflow Release --branch v1.0.0 --limit 1` (without the branch filter it
can return the PREVIOUS release's run and hand you the wrong digest — the one value that
bricks an install); the digest grep anchored as
`[0-9a-f]{64}[[:space:]]+.*conduit-.*\.tar\.gz` (a bare 64-hex pattern also matches
setup-node's cache key); the published asset re-downloaded and re-hashed; the notes put
on the release explicitly because `release.yml` publishes with `--generate-notes`; and a
close-out step covering the branch, the worktree and the primary checkout.

**This release's notes must say the upgrade is not a no-op** — an apt dependency and
migration 0009, the first non-application-only release since v0.6.0 — and the live
checklist must confirm WeasyPrint is present on the server before the first quote is
raised.

- [ ] **Step 4: Do NOT merge, tag or publish.** The coordinator gates the release.

---

## The intermittent unit failure — a name, and a mechanism

> **THE HYPOTHESIS BELOW WAS TESTED IN TASK 4 AND IS FALSIFIED AS STATED.** `waitFor`'s
> 10-second deadline is unreachable -- vitest's default 5000ms `testTimeout` fires
> first and no `vitest.config.ts` raises it -- so the `timed out waiting for` label
> can never appear, and every sighting's message is vitest's own. Nor is it a
> slowdown: the case costs 180-240ms normally, 4% of its budget. Twelve runs idle
> failed once; twelve runs against a second vitest process failed eight times. The
> section is left as written; the measurements are in Task 4's DONE block.

Three sightings across two phases, all previously unnamed: Phase 6 Task 6 (two
consecutive runs, `1 failed | 1828 passed`), Phase 7 Task 1, and now Phase 7 Task 3,
which finally caught one — **`mail-sync.test.ts`, a backoff case**, passing alone and on
re-run with CI green throughout.

**FALSIFIED by Task 4, which reproduced it.** vitest's default 5000ms `testTimeout`
always fires before `waitFor`'s own 10s deadline, so that label can never appear and the
hypothesis below is wrong. Nor is it a slowdown: the case normally costs 180-240ms, about
4% of the budget, and instead of running slowly it **wedges**. Twelve runs on an idle
server failed 1; twelve against a second concurrent vitest process failed 8 — so
contention amplifies a real race rather than being its cause, which is why an
uncontended experiment could keep coming back clean. **Next suspect, untested:**
`ManualClock.wait(ms <= 0)` resolving without registering a pending entry, so a
`waitFor(() => clock.pendingCount() > 0)` waits for something that has already happened
and never will again. The original hypothesis is left below because the reasoning that
produced it is still the right shape, and because a falsified hypothesis someone can see
is worth more than a deleted one.

**Original hypothesis, from reading the code rather than another run — WRONG.** `waitFor`
(`packages/api/src/services/mail-sync.test.ts:453`) polls its predicate every 5ms against
a **10-second wall-clock deadline** and throws `timed out waiting for <label>`. That
shape fails under CPU starvation while the code under test is entirely correct, and it
fails with a label rather than an assertion — which is exactly why the earlier sightings
produced no useful name to capture. There are twenty-odd `waitFor` call sites in that
file, so the specific case that loses the race varies with which one is unlucky, and no
two sightings need name the same test.

**Why the earlier experiment came back clean.** The ten-run contended/quiet experiment
recorded in the Phase 6 plan loaded **Postgres** — a dev server plus a request loop
against three endpoints. That is I/O contention. This mechanism needs the vitest process
itself starved of CPU: a concurrent `npm run build`, a second suite, or another agent's
work on the same box. Every sighting so far has been during exactly that.

**How to confirm cheaply**, for whichever task next has the server to itself: run the
suite with the CPU saturated (N+2 busy loops) rather than the database busy, and see
whether a `timed out waiting for` failure appears. A clean negative under CPU load would
falsify this and is worth as much as a reproduction.

**Do not "fix" it by raising the timeout** without confirming the mechanism first. If the
hypothesis is right the honest fix is to make those waits deterministic — the file
already has a `ManualClock`, and a deadline measured in wall-clock time inside a test
that controls its own clock is the actual defect.

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| Quote from a deal, numbered, branded PDF | 4, 5 |
| Line items on the document, not the deal | 2 (schema), 5 (editor) |
| One editable template per type | 2 (seed), 3 (merge), 5 (editor) |
| Per-type per-year numbering | 2 (table), 4 (allocation) |
| Immutability | 4 (the central test) |
| No draft state | 4 (a row means a PDF exists) |
| Recipient snapshot | 2 (columns), 4 (populated at issue) |
| PDF is the artifact | 4 (stored blob is authoritative; no re-render offered) |
| Org profile is new and required | 2 (table), 4 (service), 5 (settings) |
| No network during render | 3 (remote URLs stripped), 1 (no --base-url) |
| Timeout and output cap | 1 |
| Not the mail sanitiser profile | 3 |
| Unknown merge field renders empty | 3 |
| Money arithmetic specified and tested | 2 |
| Works on a phone | 5 (gate), 6 (e2e) |
| Packaging risk proved first | 1 |
| Integration tests skip without the binary | 1, 4 |
