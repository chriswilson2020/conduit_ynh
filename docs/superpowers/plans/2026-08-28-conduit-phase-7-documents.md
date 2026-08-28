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

- **Migrations are generated, never hand-written and never pushed.** `npx drizzle-kit generate` after editing `packages/api/src/db/schema.ts`. **NEVER run `drizzle-kit push`.** An unshipped migration may be edited in place (keep the journal timestamp, hand-edit the snapshot, converge `conduit_test` with psql); a shipped one never.
- **Server work goes through the dev checkout:** `CONDUIT_REMOTE_DIR=/home/chris/conduit-phase4 ./scripts/remote.sh '<cmd>'`. Pass that variable **explicitly on every call** — the default points at a different checkout and a previous session overwrote it.
- **Vitest runs from the repo root.** The root global setup migrates Postgres before any project's tests, so the suite needs a database.
- **ASCII only** in source and tests. **Targeted `git add`** — never `git add -A`.
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
- **The CSS is flat with no nested at-rules**, because a literal `{{` in a stylesheet
  would be eaten as a merge field. The test asserts every `{{` in the body is one of the
  25 tokens.
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
**7,036,874,417,766,401** (2^46 units; it prints ...664.02 for ...664.01), identical in
en-GB, nl-NL, en-US and de-DE because the loss happens in the divide before Intl sees the
number. That is BELOW `money.ts`'s own ceiling, so the formatter refuses at it rather
than leaving a sliver where a total is storable but not exactly printable. **And a
limitation that is not new**: the divide is by 100 while the decimal places come from the
currency, so a zero-decimal currency like JPY reads 1,100,000 back as 11,000 yen. That is
Conduit's stored model since `deals.value_cents`, unchanged from the five sites this
replaced, and a column problem rather than a formatting one -- pinned by a test so it
stays visible.

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
