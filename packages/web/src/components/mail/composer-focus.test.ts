import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../test/source";

/**
 * THE COMPOSER'S OPENING FOCUS, PINNED IN THE SOURCE, BECAUSE ITS ONLY OTHER
 * DESKTOP GUARD DEPENDS ON A NETWORK TIMEOUT.
 *
 * The behaviour is proved in e2e (e2e/composer-focus.spec.ts and the composer
 * assertions in e2e/mail.spec.ts and e2e/mobile.spec.ts) and that is where it
 * belongs -- this repo has no testing-library, so JSX has no unit-level check
 * except its text. But exactly ONE of those e2e tests separates the new
 * desktop behaviour from the old one: a blank compose at 1280 lands on the To
 * input either way unless a From combobox sits in front of it, and the only
 * fixture that puts one there is a mail account whose IMAP host is
 * unreachable. That account stays `active` for as long as a TCP connect to
 * 192.0.2.1 hangs -- about 25 seconds on the dev server, and nothing on a
 * network that answers with an immediate ICMP unreachable. If that test is
 * ever quarantined for flaking, the objected-to half of the coordinator's
 * ruling -- change the desk, not just the phone -- would retire with it and
 * nothing would say so.
 *
 * So this file is the second guard, and it is deliberately a different KIND of
 * guard rather than a second instance of the same one: it needs no browser, no
 * database and no network, and it fails on the same mutation.
 *
 * IT MATCHES SPELLINGS, NOT BEHAVIOUR, which is the honest limit and the same
 * one components/touch-floors.test.ts states about itself. A spelling that is
 * present but wired to nothing would pass here; that is what the e2e is for.
 * What this cannot miss is the whole mechanism being deleted.
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
    // The null-handle branch in Composer's own handler.
    expect(composer).toContain("container.focus();");
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
