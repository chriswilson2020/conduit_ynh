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

   **So the renderer has three controls, and the third is deliberately untested.**
   (1) the `data:`-only fetcher; (2) `rel=attachment` deleted from the parsed tree
   before rendering, which is upstream of whichever fetcher a version uses and covers
   `<a rel=attachment>` as well as `<link>`; (3) the finished PDF is refused if it
   contains embedded files at all. Only (3) is a statement about the output rather than
   a mechanism, which is why it is there — and no test can reach it while (2) closes the
   only route HTML has. That is recorded in the code comment rather than left for a
   reviewer to find.

   **The lesson worth carrying into Task 3:** the previous suite tested exactly one
   scheme and generalised to "fetches nothing". Anything asserting a no-network or
   no-read property must be parametrised over schemes — and asserted as a property,
   because the mechanism moves between versions.
2. **Step 4's `renderPdf` resolved a zero-byte "PDF".** A child that exits 0 having
   written nothing returned `Buffer.concat([])`, which would have put an empty file in a
   deal's Files with no error raised anywhere. The shipped version treats a stdout that
   does not begin `%PDF-` as a failed render. Its `fail()` also clears its own timeout
   rather than relying on the `close` event — the one event a timeout exists to survive
   the absence of.
3. **Step 2's test file would have skipped every failure path** on any machine without
   the binary, which is backwards for code whose whole job is failing well. The shipped
   tests are in two halves: **nine** stub-driven tests shadow `python3` on `PATH` with a
   shell script and run EVERYWHERE (non-zero exit with stderr, a child that exits before
   reading a 500KB stdin, a timeout firing mid-chunk with a marker file proving the child
   was killed, the size cap, exit-0-with-no-PDF, exit-0-with-garbage, ENOENT, the
   PDF passthrough, and the availability probe).
4. **The gate is NOT the MAIL_IT pattern the spec names.** `MAIL_IT` is an explicit
   opt-in, so a broken fixture fails loudly; this one probes, so a packaging change that
   stopped delivering WeasyPrint would turn the real half into silent skips with CI still
   green. A `runIf(process.env.CI)` test asserts the binary is present whenever CI runs.
5. **Import specifiers are `.js`, not `.ts`** — NodeNext, and the repo convention.

**Measured, so later tasks stop guessing.** All figures from the server (Debian 12,
WeasyPrint 57.2) running the SHIPPED script, not a stripped-down one — the embedded-file
backstop costs about 30ms of the total, which is why an earlier draft of this paragraph
said 570-580ms. A one-page quote (A4, `@page` margins, a running footer, a `data:` logo,
8 line items, totals, terms) renders in **600-680ms to ~14,002 bytes** (**629-680ms /
~12,460 bytes** on CI's 61.1) at **66-67MB peak RSS**. A 435KB, 40-page document costs
**3.7s, 97MB RSS, 120KB out**.

- The **20s timeout** is ~30x the one-page render and bounds how long Task 4's
  transaction holds its row lock, so it should not grow.
- The **25MB output cap** is not a tuned limit but a bound on what is accumulated in
  memory from a runaway stream; anything near it would hit the timeout first.
- The **2MB input cap** is new (nothing bounded input before) and IS tuned: 435KB of HTML
  costs 3.7s, so 2MB is roughly where the timeout would bite anyway — this makes that
  failure immediate instead of costing 20s and 100MB first.
- `ram.runtime` went 400M -> **700M**: a render is a separate Python process, and 300M is
  three at a rounded 100MB ceiling. **Three is a number Task 4's concurrency limit has to
  match; until that limit exists, nothing bounds this at all.**

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

---

### Task 3: Templates — the sanitiser profile and merge resolution

**Files:**
- Create: `packages/api/src/services/documents-template.ts`, `documents-template.test.ts`

Both halves are pure functions. Everything about this task is unit-testable without a
database, and it should be tested to exhaustion — it is the layer that turns
user-authored HTML into something a renderer is handed.

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
