# Conduit — focus after navigation

**Status:** spec, awaiting Chris's approval.
**Target release:** v1.5.0.
**Predecessor:** v1.4.1, shipped and installed 4 Sep.
**Then:** Phase 4.4, on Chris's ordering.

---

## Why this is next, when it was filed as "later" the same morning

It has been the biggest item on the deferred list for three releases, which is a phrase rather
than a plan. On 4 Sep I filed it as product-readiness gated on a second user, reasoning that
Chris does not navigate by keyboard so it costs nothing today.

**He overruled it within the hour: "I don't use the keyboard but others might."** That is an
argument for fixing it, not for waiting -- a trigger that fires when a stranger meets the defect
fires too late to help that stranger, and the position it leaves you in is "we knew, and
scheduled it behind four other things". The backlog keeps the struck-through paragraph rather
than deleting it, because the wrong argument is the useful part of the record.

---

## The defect

**Focus is lost after any navigation that unmounts the focused element.** The element goes away,
focus falls to `<body>`, and a keyboard user's next Tab starts from the top of the document
rather than from where they were. A screen reader announces nothing, because nothing moved.

**It is a route-change concern touching every page**, which is precisely why it has never fitted
in a corner of somebody else's release.

---

## What already exists, and why it is evidence rather than prior art to preserve

**Two pages solved it by hand, independently, and both reached the same answer.**

- `pages/inbox.tsx` moves focus to the heading on every level change.
- `pages/board.tsx` moves focus to the heading when a move unmounts the focused control.

**Both chose the HEADING, and `inbox.tsx` records why the obvious alternative was rejected** --
focusing the new level's leading control does nothing when that control is the same DOM node
before and after, because `focus()` on the already-focused element fires no event and
re-announces nothing. The heading "genuinely moves, so it is announced; it announces the
DESTINATION ('Conversation, heading level 1') rather than the exit ('Back, button')".

**That is the general answer, arrived at twice by people solving one page each.** This spec
generalises it and DELETES both, rather than adding a third hand-rolled case.

`components/ui/dialog-focus.ts` is not in scope and does not change: it owns returning focus to
whatever opened a dialog, which is a different question with a correct answer already.

---

## Design

### When: only when focus was actually lost

After a route change, if `document.activeElement` is `<body>` (or `null`), move focus.
Otherwise leave it exactly where it is.

**This is the whole of the restraint, and it is taken from a measurement already in this
codebase.** `inbox.tsx` rejected a broader trigger for exactly this reason: keying on more than
the level "would cover one more case ... at the cost of a focus jump on every phone visit to
this page", and the uncovered case "is a focus loss nobody will meet; the jump would be met
every time".

The same logic applies here at app scale. A rule that moves focus on EVERY navigation is met by
every user on every click; a rule that moves it only when focus is already on `<body>` is met
only by the people the defect harms.

### Where: the first VISIBLE `<h1>`, made focusable with `tabIndex={-1}`

Measured across the app rather than assumed: 13 pages carry their own `<h1>`, several carry two
(a responsive pair, only one of which is visible at a time), and the five settings panels carry
none -- they sit under `components/settings-layout.tsx`'s `<h1>Settings</h1>`.

**Picking the first VISIBLE one is what makes a single rule cover all three shapes.**

`tabIndex={-1}` rather than inventing a control that exists only to be focused -- `inbox.tsx`'s
phrasing, and its reasoning holds.

### The five settings panels get their own headings — Chris's decision, 4 Sep

Without this, switching from Mail accounts to Export announces "Settings", because that is the
nearest heading. **Each of the five panels gets an `<h1>` naming itself**, so the general rule
needs no special case and the destination is announced accurately.

The layout's existing "Settings" becomes a sibling heading or a styled non-heading; whichever is
chosen, **there must not be two `<h1>`s visible at once on those routes**, or the rule's "first
visible" becomes a coin toss between them.

---

## The risk that must be handled rather than noted

**A MOUSE USER CLICKING A ROW LINK ALSO DROPS FOCUS TO `<body>`.** The link unmounts with the
page it was on, so the trigger above fires for them too, and the heading takes focus.

That is harmless -- until it paints a focus ring, at which point every mouse click on every row
in the product ends with a box drawn round the next page's title.

**So the ring must be `:focus-visible`-gated, and that needs a test.** "It looked fine on my
machine" is how a focus fix gets justified, and this project has spent three releases learning
what happens when a visual claim is never asserted. The assertion is on the computed style of
the focused heading after a programmatic focus, not on a screenshot.

---

## Definition of done

- Focus lands on the destination heading after any navigation that would otherwise have dropped
  it to `<body>`, and **stays where it is** after any navigation that would not.
- `pages/inbox.tsx` and `pages/board.tsx`'s hand-rolled effects are **deleted**, not left beside
  the general one. If either turns out to cover something the general rule does not, that is a
  finding to report before deleting it.
- The five settings panels each announce themselves.
- **No focus ring for a mouse user**, asserted rather than observed.
- Every existing focus test still passes -- there are several, and they are the reason this is a
  change that can be made at all.
- Full unit and e2e green, counts accounted for. **No migration.**

---

## Risks

1. **The trigger fires on mouse navigation too.** Named above; handled by `:focus-visible`, and
   the test is the deliverable rather than the fix.
2. **Deleting two working workarounds can uncover what they were really for.** Both are
   documented at length and neither comment is trustworthy on its own -- `board.tsx`'s mentions a
   test "there is no such test in this file any more". Read the tests, not the comments.
3. **TanStack Router's navigation hook is the one piece not yet chosen**, because the right
   place to subscribe (a root-route effect, a router subscription, or a `useLocation` effect)
   depends on when the new page's DOM exists. Focusing a heading that has not rendered yet is a
   no-op that looks like the fix working on a fast machine.
4. **The settings heading change touches five shipped pages** and is the only part of this that
   a user sees rather than feels.
