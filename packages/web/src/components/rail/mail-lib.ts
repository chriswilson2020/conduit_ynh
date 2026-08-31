/**
 * The Mail rail tab's one pure part: whether its Compose button may be pressed,
 * what to say when it may not, and which hops a Retry should ask again.
 *
 * Kept out of mail.tsx so it can be unit-tested without a DOM -- this project
 * wires no testing-library, so a component's logic is only reachable by a test
 * once it is a pure module (components/mail/mail-lib.ts is the precedent, and
 * rail/meetings-lib.ts and rail/timeline-lib.ts follow it).
 *
 * Nothing here touches the network or React.
 */

/**
 * WHY THERE IS A GATE AT ALL.
 *
 * The rail builds the composer's seed AT CLICK TIME from up to two queries,
 * and from a deal tab they are chained: the deal, then
 * `useContact(deal.contactId)`. A click that lands before the second one
 * answers seeds `to: []` -- a compose addressed to nobody, indistinguishable on
 * screen from a deliberate blank one. Measured in Chromium against the real app
 * with the contact GET held open: the composer opened with an empty To and the
 * caret in it.
 *
 * WHY IT IS THREE STATES AND NOT A BOOLEAN. v1.1.0 considered "disable until
 * the data arrives" for the blank-quote race and REFUSED it, because that shape
 * cannot tell "not yet" from "never": a hop that 404s or 500s leaves a dead
 * button with nothing on screen to explain it. The refusal was about the
 * silence, not about the disabling -- so the pending state carries a reason,
 * the failed state does NOT disable anything and offers a Retry, and the
 * settled state is simply allowed.
 *
 * AND `to: []` IS NOT ALWAYS WRONG, which is the third state's whole point. A
 * deal with no linked contact, a project tab and a company tab all have nothing
 * to seed and never will -- a company carries a domain, not a mailbox -- so
 * they compose with an empty To exactly as before. The defect is an empty To
 * BECAUSE THE DATA HAS NOT ARRIVED, not an empty To.
 */
export type ComposeGate = "ready" | "resolving" | "failed";

/**
 * One link in the chain, as the three fields this gate reads off a TanStack
 * query result.
 *
 * `data` IS IN HERE BECAUSE A FAILURE IS NOT ALWAYS A LOSS. Measured against
 * the installed @tanstack/query-core 5.101.4: a query that succeeded and whose
 * REFETCH then fails goes to `status: "error"` while its data survives --
 * `isError: true`, `data: {...}`. With `staleTime: 10_000` and
 * `refetchOnWindowFocus` left at its default (router.tsx sets only staleTime
 * and retry), one transient 500 on a tab refocus would otherwise paint "could
 * not load the contact" beside a composer that goes on to seed that contact
 * correctly. A hop holding data is USABLE, whatever its status says.
 *
 * `fetchStatus` RATHER THAN `isPending`, which is also what
 * pages/deal-detail.tsx's `defaultsInFlight` reads, and the reason to match it
 * is the OFFLINE state neither `isPending` nor `isError` describes.
 * `networkMode` is the default "online" here, so an offline fetch is PAUSED:
 * measured, `fetchStatus: "paused"`, `isPending: true`, `isError: false`,
 * queryFn never called, and it stays that way until the network returns. A gate
 * built on `isPending` would sit at "resolving" for ever with no error to
 * escape through -- exactly the "cannot tell 'not yet' from 'never'" shape
 * v1.1.0 rejected -- and it is reachable, because pages/deal-detail.tsx mounts
 * this rail inside its `isLoading` branch. So paused counts as stalled, not as
 * in flight.
 *
 * (An earlier draft claimed `fetchStatus` reads "idle" for one commit after a
 * chained key goes live, so a gate on it would flicker open. THAT IS FALSE.
 * Measured through useBaseQuery's own per-render sequence with the key flipping
 * "" -> "contact-1": `fetchStatus` is already "fetching" on that very render,
 * because getOptimisticResult applies `fetchState()` when `_optimisticResults`
 * is set and the query would fetch. The window exists for the network call and
 * not for the reported status.)
 *
 * THERE IS DELIBERATELY NO `enabled` FLAG, and an earlier draft's was deleted
 * rather than kept. Every hook in queries.ts is `enabled: id !== ""`, so it was
 * tempting to restate that test here -- but a DISABLED query reports exactly
 * the same three fields as one that has simply not been asked for: no data,
 * `fetchStatus: "idle"`, no error. Both predicates below require a REASON, so
 * such a hop is neither in flight nor stalled and needs no flag to be ignored.
 * Measured in v1.2.1, when this gate still had four hops and that file ten
 * journeys: with the flag forced true on all four, every one of the ten still
 * passed and the only red was the source guard that existed to protect the flag
 * itself. (v1.2.2 narrowed the chain to two -- see mail.tsx -- which cannot
 * revive a flag that measurement retired.) Restating queries.ts's
 * predicate across a module boundary bought nothing and could drift; not
 * restating it cannot. Drift is still caught, behaviourally and in both
 * directions -- see the journeys' own note.
 */
export interface ComposeHop {
  /** `undefined` until something has arrived; survives a later failed refetch. */
  readonly data: unknown;
  readonly isError: boolean;
  readonly fetchStatus: "fetching" | "paused" | "idle";
}

/** Holds nothing to seed from. */
function empty(hop: ComposeHop): boolean {
  return hop.data === undefined;
}

/** Empty, and something is on the wire for it. */
function inFlight(hop: ComposeHop): boolean {
  return empty(hop) && hop.fetchStatus === "fetching";
}

/**
 * Empty, and nothing is coming: it failed, or the network is gone.
 *
 * THE REASON IS REQUIRED, not inferred from "empty and not fetching". A query
 * that was never asked for -- `useContact("")` on a deal with no contact, and
 * BOTH hooks on a company tab or a project one -- is empty and idle with no
 * error, and without this clause it would read as a failure and paint an alert
 * on every record in the app.
 *
 * A hop CAN be in flight and stalled at once as a matter of type -- no data,
 * `isError`, and `fetchStatus: "fetching"` -- and composeGate resolves that by
 * order. THE COMMENT HERE USED TO SAY THAT IS WHAT THE RETRY BUTTON MAKES, AND
 * THAT IS FALSE. Driven through a real QueryObserver against the installed
 * @tanstack/query-core 5.101.4: a query that has never succeeded reports
 * `isError: false, fetchStatus: "fetching", data: undefined` while its refetch
 * is out, because `fetchState()` resets `error` and `status` whenever
 * `data === undefined`. So through queries.ts that combination is unreachable,
 * and since v1.2.2 narrowed this chain to deal -> contact no two hops can hold
 * the two states either (the contact's key comes from the deal, so a deal that
 * has not answered never starts a contact fetch). The order below is kept
 * anyway: it is a rule about an argument, this module is generic over the
 * chain it is handed, and mail-lib.test.ts is where it is guarded.
 */
function stalled(hop: ComposeHop): boolean {
  return empty(hop) && (hop.isError || hop.fetchStatus === "paused");
}

/**
 * The gate over a whole chain.
 *
 * IN FLIGHT WINS OVER STALLED when a hop is both, because the button's state is
 * the question being answered and a chain with anything on the wire must not be
 * pressed yet. Nothing is lost by reporting the failure a render later: a hop
 * that fails again comes back stalled with the fetch over.
 *
 * NOTHING THE RAIL CAN HAND THIS FUNCTION TODAY DISTINGUISHES THE TWO ORDERS --
 * see `stalled` above for the two measurements that say why -- so the order is a
 * decision about an input rather than an observable behaviour of the app. It is
 * stated here, and pinned in mail-lib.test.ts, so that a chain which does reach
 * the overlap again inherits the answer instead of rediscovering it.
 */
export function composeGate(hops: readonly ComposeHop[]): ComposeGate {
  if (hops.some(inFlight)) return "resolving";
  if (hops.some(stalled)) return "failed";
  return "ready";
}

/**
 * The hops a Retry should ask again: the same predicate the "failed" state is
 * built on, exported rather than restated so the control cannot drift from the
 * message beside it.
 *
 * SCOPED TO THE STALLED HOPS RATHER THAN REFETCHING EVERYTHING, and that is not
 * tidiness. Measured: `refetch()` on a DISABLED query goes to the network
 * anyway -- queryFn calls went 0 to 1 against query-core 5.101.4 -- so a Retry
 * that asked every hop would send `GET /contacts/` with an empty id from every
 * deal that has no contact.
 */
export function stalledHops<T extends ComposeHop>(hops: readonly T[]): readonly T[] {
  return hops.filter(stalled);
}
