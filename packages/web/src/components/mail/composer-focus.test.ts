import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../test/source";

/**
 * THE COMPOSER'S OPENING FOCUS, PINNED IN THE SOURCE.
 *
 * The behaviour is proved in e2e (e2e/composer-focus.spec.ts and the composer
 * assertions in e2e/mail.spec.ts and e2e/mobile.spec.ts) and that is where it
 * belongs -- this repo has no testing-library, so JSX has no unit-level check
 * except its text. This file is a second guard of a different KIND: no
 * browser, no database, no network, and it fails on the same mutation.
 *
 * ITS FIRST STATED REASON FOR EXISTING WAS FALSE and is corrected here rather
 * than deleted, because the correction is the useful part. It said "exactly
 * ONE e2e test separates the new desktop behaviour from the old one", that one
 * being the blank compose at 1280 which needs an unreachable-mailbox fixture to
 * put a From combobox in front of the To input. There are TWO. The other is a
 * record's Mail tab at 1280, which needs no mailbox at all: its To arrives
 * holding a chip, and a chip's "Remove <address>" button is the first tabbable
 * element, so the old and new behaviours differ there for free. Measured, not
 * argued -- under the mutation that deletes onOpenAutoFocus,
 * e2e/composer-focus.spec.ts:128 failed in CI run 33308943883 with no account
 * in the database, and e2e/composer-focus.spec.ts's own header said so in the
 * same commit that got this wrong.
 *
 * So the desk is not one flaky fixture away from being unguarded, and this
 * file is worth keeping for a smaller reason: it is the only guard here that
 * cannot flake, and it names the mechanism rather than its consequences.
 *
 * WHAT IT ACTUALLY GUARANTEES, STATED NARROWLY BECAUSE A SOURCE-READING GUARD
 * CANNOT DO MORE. It prevents the mechanism being removed BY OMISSION -- a
 * deleted prop, a deleted branch, a dropped option. It does not survive
 * deliberate tampering, and the honest response to that is to say so rather
 * than to widen the match until it looks stronger:
 *
 *   - Renaming the prop, or moving the handler to an element that does not
 *     take it, is caught by `npm run typecheck`, which CI runs. Not by this.
 *   - A spelling in a string literal, or after a TRAILING `//` comment,
 *     satisfies these assertions: test/source.ts's withoutComments strips
 *     block comments and LINE-LEADING `//` only, and its own doc explains why
 *     that restriction is deliberate.
 *   - `if (false as boolean) form_.focusInitial(container)` passes.
 *   - So does reverting the pending-flag fix in ComposerForm's drain effect
 *     (spending bodyFocusPending before there is an editor to spend it on),
 *     which nothing in this file or in typecheck sees at all.
 *
 * Task 1 reached the same place and the answer was the same: narrow the claim
 * rather than widen the match. components/touch-floors.test.ts states the same
 * limit about itself in one line.
 */

const read = (path: string) =>
  withoutComments(readFileSync(new URL(path, import.meta.url), "utf8"));

const composer = read("./composer.tsx");
const richText = read("./rich-text.tsx");

/**
 * The source between two markers, with both ends asserted to exist so a rename
 * that silently emptied the slice fails loudly instead of guarding nothing --
 * the discipline components/touch-floors.test.ts records for the same reason.
 *
 * SCOPING MATTERS MORE HERE THAN IT LOOKS. `event.preventDefault()` appears
 * SIX times in composer.tsx: the submit handler, four keyboard branches in the
 * recipient field, and the one this file is about. A file-wide `toContain` for
 * it passed with the opening-focus handler deleted outright, which is the
 * single mutation this file exists to catch.
 */
function between(source: string, marker: string, endMarker: string): string {
  const at = source.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, at);
  expect(end, `end marker not found after ${marker}: ${endMarker}`).toBeGreaterThan(at);
  return source.slice(at, end);
}

describe("the composer declines Radix's opening focus and places its own", () => {
  /**
   * WITHOUT THIS PROP the dialog opens on its first tabbable descendant, and
   * measured before v1.2.0 that was three different wrong elements: the
   * md:hidden Close at 390, the From combobox at 1280 with a mailbox
   * configured, and a chip's "Remove <address>" button at 1280 without one.
   */
  it("passes onOpenAutoFocus to its DialogContent", () => {
    expect(composer).toContain("onOpenAutoFocus");
  });

  /**
   * AND preventDefault IS LOAD-BEARING, not decoration. Focus is placed inside
   * the handler, which runs during Radix's AUTOFOCUS_ON_MOUNT dispatch -- after
   * the `if (!container.contains(document.activeElement))` gate has already
   * passed, since the caret is still on the opener. Radix then runs focusFirst
   * unless the event is prevented, so all three targets would be overwritten.
   */
  it("prevents the default so focusFirst never runs", () => {
    const handler = between(composer, "onOpenAutoFocus", "focusInitial(container)");
    expect(handler).toContain("event.preventDefault()");
  });

  /**
   * THE THREE TARGETS. Deleting a branch is a likelier regression than
   * deleting the prop, and it is invisible at 1280 for the To branch (the To
   * input is the first tabbable element there once no combobox is in front of
   * it), so it is worth naming each one.
   */
  it("reaches all three targets", () => {
    expect(composer).toContain("toRef.current");
    expect(composer).toContain("subjectRef.current");
    expect(composer).toContain("bodyFocusPending.current = true");
  });

  /**
   * EVERY BRANCH ENDS INSIDE THE CONTENT. preventDefault has disabled both of
   * Radix's fallbacks -- focusFirst, and its own focus(container) when that
   * finds nothing -- so a branch that focuses nothing leaves the caret on the
   * opener, OUTSIDE the portal, where the trap cannot reclaim it: its focusin
   * handler recovers by focusing lastFocusedElementRef, still null because
   * nothing inside has ever held focus. Not reachable today. That is why it is
   * pinned rather than left to stay true on its own.
   */
  it("falls back to the dialog container on every branch", () => {
    expect(composer).toContain("(toRef.current ?? container).focus()");
    expect(composer).toContain("(subjectRef.current ?? container).focus()");
    // SCOPED, AND THE UNSCOPED VERSION WAS A HOLE. `container.focus();` is
    // spelled twice in this file -- here in the null-handle branch, and again
    // in focusInitial's own body branch, which parks focus while the editor is
    // built. A file-wide match was therefore satisfied by the second one, so
    // deleting precisely the null-handle branch this assertion is named after
    // left the guard green and the typechecker clean. Same defect as the
    // preventDefault assertion above, found the same way.
    const nullHandle = between(composer, "if (form_ === null)", "form_.focusInitial");
    expect(nullHandle).toContain("container.focus();");
  });
});

describe("the signature append leaves the caret where the user put it", () => {
  /**
   * insertContentAt UPDATES THE SELECTION BY DEFAULT, which moved the caret to
   * the end of the appended signature. Before v1.2.0 nothing had put a caret
   * in this editor by the time the signature landed, so it could not be seen
   * on open -- but switching accounts mid-message appends the new signature
   * and dragged a typing user's caret with it.
   *
   * e2e/composer-focus.spec.ts's account-switch journey is the behavioural
   * guard and is the one that matters. This line is here because that journey
   * needs TWO simultaneously-active mail accounts, and they are active only
   * for as long as the same unreachable-host timeout holds.
   */
  it("passes updateSelection: false", () => {
    expect(richText).toContain("updateSelection: false");
  });
});

describe("the composer stamps its signature guard from what it appended", () => {
  /**
   * THE v1.2.1 FIX IS A COUPLING, AND THIS IS WHAT STOPS IT BEING UNCOUPLED BY
   * OMISSION. mail-lib's signatureAppend hands back the guard key together
   * with the HTML, so the effect has no key to stamp unless a signature was
   * actually found; the rule's own behaviour is tested beside it in
   * mail-lib.test.ts, sequence by sequence. What is left for this file is that
   * the composer still takes its key from there instead of building one.
   *
   * THE DEFECT IT REPLACES WAS INVISIBLE TO EVERY BROWSER TEST IN THIS REPO. A
   * `signedFor.current` assignment restored above the lookup only loses a
   * signature while the selected account is missing from the accounts list,
   * and every e2e fixture here has a warm one. Measured in Chromium against
   * the real component with the accounts request held for 800ms: the body
   * ended empty.
   *
   * NARROW ON PURPOSE, in the shape this file's header records for the rest of
   * its assertions -- it stops a deleted line, not a determined author. A
   * hand-built key assigned somewhere else in the effect would satisfy it.
   */
  it("stamps only the key signatureAppend handed back", () => {
    const effect = between(composer, "const append = signatureAppend({", "appendAtEnd");
    expect(effect).toContain("signedFor.current = append.key;");
  });
});
