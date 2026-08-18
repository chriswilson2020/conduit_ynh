# Conduit Phase 2 — Pipelines & Deals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scoped pipelines with drag-and-drop deal kanban, won/lost tracking, funnel view and SSE live sync, released as v0.3.0.

**Architecture:** Three new tables plus deal FKs threaded into events/notes/files. Services copy the Phase 1 hardened pattern; deal moves compute fractional positions server-side from neighbour ids. An in-process SSE hub broadcasts query-key invalidation hints. The kanban is @dnd-kit with optimistic moves.

**Tech Stack:** Existing stack + `@dnd-kit/core` + `@dnd-kit/sortable` (web only). No new backend dependencies.

---

## Conventions

Identical to Phase 1's plan (remote.sh for every command, NodeNext `.js` extensions in api / none in web, ASCII-only with `\u` escapes, ApiError code/status branching, testids for structure + roles for controls, CI is the Playwright runner). Suite at start: 184 unit + 10 e2e, all green. The hardened service pattern lives in `services/companies.ts` + `contacts.ts` (atomic guards, diff events) — copy it, never the pre-review shape.

## File structure

| Path | Responsibility |
|---|---|
| `packages/shared/src/fractional.ts` (+test) | `midpoint(a: string \| null, b: string \| null): string` base-62 lexicographic fractional index |
| `packages/shared/src/index.ts` | + pipeline/stage/deal schemas, inputs, funnel row, SSE hint schema, verbs, search deals group |
| `packages/api/src/db/schema.ts` + `drizzle/0002_*` | `pipelines`, `stages`, `deals`; `deal_id` on events/notes/files with widened CHECKs; new verb CHECK values |
| `packages/api/src/services/pipelines.ts` (+test) | Pipeline CRUD/archive + stage create/rename/reorder |
| `packages/api/src/services/deals.ts` (+test) | Deal CRUD/archive, moveDeal, win/lose/reopen, listDeals, funnel |
| `packages/api/src/services/sse.ts` (+test) | In-process hub: `publish(keys: string[][])`, `subscribe(fn)` returning unsubscribe |
| `packages/api/src/routes/{pipelines,deals,stream}.ts` (+tests in routes.test.ts) | REST + SSE endpoint |
| `packages/api/src/services/search.ts` | + deals group (title ILIKE, archived + non-open excluded? no: archived excluded only) |
| `packages/web/src/queries.ts` | + pipeline/stage/deal hooks, funnel, optimistic moveDeal |
| `packages/web/src/pages/{pipelines,board,deal-detail}.tsx` | Index, kanban board (+funnel toggle), deal page |
| `packages/web/src/components/{kanban,funnel,sse}.tsx` | dnd-kit board, CSS funnel bars, EventSource client |
| `e2e/pipeline.spec.ts` | The Phase 2 journey |

---

### Task 1: Fractional indexing + shared contracts + schema

`packages/shared/src/fractional.ts` — implement exactly:

```typescript
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Lexicographic fractional index: returns a string strictly between a and b.
 * null a = beginning, null b = end. Strings use base-62 digits; ordering is
 * plain string comparison. Repeated midpoints grow the string by at most one
 * digit per insertion between the same neighbours.
 */
export function midpoint(a: string | null, b: string | null): string {
  const lo = a ?? "";
  const hi = b ?? "";
  if (hi !== "" && lo >= hi) throw new Error(`midpoint: ${lo} >= ${hi}`);
  let result = "";
  let i = 0;
  for (;;) {
    const dLo = i < lo.length ? DIGITS.indexOf(lo[i]!) : 0;
    const dHi = i < hi.length ? DIGITS.indexOf(hi[i]!) : DIGITS.length;
    if (dHi - dLo > 1) {
      result += DIGITS[Math.floor((dLo + dHi) / 2)]!;
      return result;
    }
    result += DIGITS[dLo]!;
    i += 1;
    if (i > lo.length && i > hi.length && i > 64) throw new Error("midpoint: unreachable growth");
  }
}
```

Wait — verify this handles `midpoint("a", "b")` (adjacent digits: descends into `a` + midpoint of ("", "")-suffix territory) and `midpoint(null, "0")` (must produce something below "0": impossible in this scheme — the FIRST insertion must therefore be `midpoint(null, null)` = "U" (middle digit), and inserting before the current head uses `midpoint(null, head)`; if head is "0" the loop appends "0" then recurses into suffix space, yielding "0" + mid — but "0X" > "0"! **This naive version is WRONG for insert-before-smallest-suffix cases.** The implementer must use the well-known correct algorithm instead: port the logic of the `fractional-indexing` npm package (generateKeyBetween) faithfully — integer-part + fraction handling — into `fractional.ts` (~120 lines, MIT; cite it in a comment), OR add the package as a dependency of `packages/shared` if porting proves error-prone. Either way the TESTS below are the contract:

- `midpoint(null, null)` returns a non-empty string
- inserting 100 times always-at-the-front yields strictly descending strings, each valid between null and the previous head
- inserting 100 times always-at-the-end yields strictly ascending
- 100 repeated midpoints between the same two neighbours stay strictly ordered and under 40 chars
- `midpoint(a, b)` throws when a >= b
- property blast: 500 random insertions into a growing ordered list keep the list order-consistent under plain string sort

Shared contracts: `pipelineSchema` (scope enum global|company, companyId nullable, position), `stageSchema` (probability 0-100 nullable, rotDays nullable), `dealSchema` (valueCents nullable int, currency 3 chars, status enum, lostReason/closedAt nullable, position, the FKs), create/update input schemas, `moveDealInputSchema` `{ stageId, beforeDealId?, afterDealId? }`, `funnelRowSchema` `{ stageId, count, valueCents }`, `sseHintSchema` `{ keys: string[][] }`, verbs + `stage_changed|won|lost|reopened`, search `deals` group `{ id, title }`.

Drizzle: tables per the spec (CHECKs: scope-company pairing, probability range, status enum, `lost_reason` only when lost, `closed_at` iff not open); `deal_id` added to events/notes/files, entity CHECKs widened to `num_nonnulls(company_id, contact_id, deal_id) = 1` (events keeps no CHECK on FK count), events verb CHECK extended. `DEFAULT_CURRENCY` in config (3 uppercase letters, default "EUR"). Migration 0002 generated, verified against conduit_test via the tsx throwaway, committed.

### Task 2: Pipelines service
Hardened pattern. `createPipeline` (global or company-scoped; company must exist — archived company is a valid owner, same monotonic-existence comment), stage creation appends positions via `midpoint(lastPos, null)`; `reorderStage(stageId, beforeStageId?, afterStageId?)` mirrors moveDeal's neighbour logic. Events: pipelines are timeline-relevant only to their company (event rows carry company_id when scoped, else no event — [decision] global pipeline mutations skip the events table since nothing renders them; comment it). listPipelines scope/company filters. ~12 tests.

### Task 3: Deals service
`createDeal` validates stage belongs to pipeline, company/contact exist; position = `midpoint(stageTail, null)`. `moveDeal`: transaction — re-read the two neighbour rows by id FOR the stage given, verify both (when present) currently belong to that stage (409-style StateError if not — client raced a stale board; new domain error `ConflictError` mapping to 409 `{ error: "conflict" }`), compute midpoint, update stage_id+position, emit `stage_changed` event `{ from, to }`. win/lose/reopen enforce legal transitions (open→won/lost, won/lost→open) with ConflictError otherwise; stamp/clear closed_at + lost_reason atomically. `funnel` single GROUP BY query over open deals. Deal events carry deal_id AND company_id (when set) so both timelines show them. ~16 tests incl. the move-race test with concurrent moves.

### Task 4: SSE hub + stream route + publishing
`sse.ts`: module-scoped `Set<(hint: SseHint) => void>`; `publish` never throws (subscriber errors swallowed+logged). Services publish AFTER their transaction commits (not inside): companies/contacts/notes/files/deals/pipelines mutations publish their invalidation keys (e.g. `[["deals", pipelineId], ["funnel", pipelineId], ["events"]]`). Route `GET /api/stream`: `reply.raw` SSE headers, register client, heartbeat `:hb\n\n` every 25s, cleanup on close, requires auth. Route test: inject-based SSE is awkward — use a real `listen` on port 0 in the test, fetch the stream, trigger a mutation, assert a data frame arrives, close. ~6 tests.

### Task 5: Routes + search deals
Per the spec's route list, hardened helpers, cursor rule, ConflictError→409 mapping added to mapDomainError. Search service + route gain the deals group (archived excluded; won/lost INCLUDED — finding closed deals by name is a feature). routes.test.ts grows ~12 tests (move endpoint happy + stale-neighbour 409 + funnel shape + stream smoke separately in Task 4).

### Task 6: Web queries + pipelines index + kanban board
`@dnd-kit/core`+`@dnd-kit/sortable` deps. Hooks: `usePipelines`, `useCreatePipeline`, `useStages(pipelineId)` (from pipeline detail response), `useDeals(pipelineId)`, `useMoveDeal` with optimistic update (snapshot lists, apply move locally, rollback on ApiError; on 409 conflict ALSO invalidate to refetch the board), `useWinDeal`/`useLoseDeal`/`useReopenDeal`, `useFunnel`. Pipelines page: global section + grouped company sections, create dialog (name + optional company select). Board page `/pipelines/$pipelineId`: dnd-kit columns from stages, SortableContext per column, cards draggable across; keyboard sensor enabled (needed for CI drag); "New deal" per column; stage add/rename inline. Board shows value sum per column header.

### Task 7: Deal detail + rail dealId + company pipelines + search group
Deal page `/deals/$dealId`: FieldCard (title, valueCents as currency input — display formatted, edit raw number; expectedCloseDate as date input; owner; company/contact links), Win/Lose/Reopen buttons (lose opens a reason dialog), status badge, rail with `dealId` (rail components + queries already take entity props — thread `dealId` through `useEvents/useNotes/useFiles/useUploadFile`, the note/file create calls, and the API routes' query params, which ALREADY accept deal_id after Task 5). Company detail gains a Pipelines section (company-scoped list + create). Search dropdown gains the Deals group navigating to deal pages.

### Task 8: Funnel + SSE client
Funnel toggle on the board page: per-stage bars (CSS width % of max, count + `Intl.NumberFormat` currency). `sse.tsx`: `EventSource(apiUrl("/stream"))` in the shell; on message, parse with `sseHintSchema` and `queryClient.invalidateQueries({ queryKey })` per key; exponential backoff reconnect (1s..30s) on error; close on unmount. [decision] Hints invalidate rather than patch — simple and correct with TanStack.

### Task 9: Playwright pipeline journey
`e2e/pipeline.spec.ts`, serial: create pipeline (3 stages) → 2 deals in stage 1 → keyboard-drag deal A to stage 2 (dnd-kit keyboard: focus card, Space, ArrowRight, Space; assert column membership after) → win deal B via detail page (assert badge + timeline `won` entry) → funnel toggle shows stage counts → search finds the deal → SSE smoke: with the board open in page 1, create a deal via a second context/page, assert it appears on page 1 without reload (SSE invalidation) within a generous expect timeout. CI-iterated like P1.11.

### Task 10: Release 0.3.0
Version bumps, CI green, merge to main, tag, manifest sha update — mechanics identical to P1.12. The live `yunohost app upgrade` command is left for Chris. Subpath checks from the P1.8 review ride along in the upgrade verification: hard reload at `/conduit/pipelines/...`, Link hrefs carry the prefix, bare `/conduit` redirects.
