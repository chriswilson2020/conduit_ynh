/**
 * The Mail rail tab's one pure part: whether its Compose button may be pressed,
 * and what to say when it may not.
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
 * The rail builds the composer's seed AT CLICK TIME from up to four queries,
 * and from a deal tab two of them are chained: the deal, then
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
 * the failed state does NOT disable anything and says what is missing, and the
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
 * One link in the chain, as the two things the gate needs to know about it.
 *
 * `enabled` IS NOT REDUNDANT AND CANNOT BE READ OFF THE QUERY. Every hook in
 * queries.ts is `enabled: id !== ""`, and a disabled query sits at
 * `status: "pending"` for ever in TanStack v5 -- so `isPending` alone would
 * report "still loading" on a deal that has no contact and never will, and the
 * button would never come back. TanStack exposes no `enabled` on the result and
 * `fetchStatus: "idle"` covers both "disabled" and "about to start", so the
 * caller passes the same emptiness test it passed to the hook.
 *
 * `isPending` RATHER THAN `isFetching` OR `fetchStatus`, which is the one place
 * this differs from pages/deal-detail.tsx's `defaultsInFlight` -- and the
 * difference is the second hop. When the deal answers, `contactId` becomes
 * available and the contact query becomes enabled in the SAME render, but its
 * fetch does not start until an effect runs; across that commit `fetchStatus`
 * reads "idle" while `isPending` already reads true. A gate on "in flight"
 * would flicker open there. `isPending` also lets a background refetch of
 * already-cached data through, which is right: stale data still names a real
 * recipient.
 */
export interface ComposeHop {
  /** Whether this hop's query is enabled -- i.e. whether it has an id to fetch. */
  readonly enabled: boolean;
  /** TanStack's `isPending`: enabled, and neither answered nor failed yet. */
  readonly isPending: boolean;
  /** TanStack's `isError`: answered with a failure, retries spent. */
  readonly isError: boolean;
}

/**
 * The gate over a whole chain.
 *
 * RESOLVING WINS OVER FAILED when both are present, because the button's state
 * is the question being answered and a chain with anything still on the wire
 * must not be pressed yet. Once that hop settles the failure is reported on the
 * next render -- a failed hop never becomes un-failed, so nothing is lost by
 * being late.
 *
 * A DISABLED HOP IS NOT A HOP. It contributes to neither state, which is what
 * makes a deal with no contact, a project tab and a company tab all "ready"
 * rather than either of the other two.
 */
export function composeGate(hops: readonly ComposeHop[]): ComposeGate {
  if (hops.some((hop) => hop.enabled && hop.isPending)) return "resolving";
  if (hops.some((hop) => hop.enabled && hop.isError)) return "failed";
  return "ready";
}
