import { expect } from "@playwright/test";
import type { Locator, Page, Route } from "@playwright/test";

/**
 * What more than one journey in this suite needs.
 *
 * A helper earns a place here by being about a PROPERTY OF THE APP that
 * several journeys touch, not by being convenient twice: anything scoped to
 * one journey stays in that journey's file, beside the fixtures it reads.
 *
 * Imports of this file carry the `.js` extension because e2e/tsconfig.json
 * extends the NodeNext base like everything else here; Playwright's own
 * resolver maps that back onto the `.ts` (its kExtLookups table), so the
 * spelling that typechecks is also the one that runs.
 */

/**
 * Type into one of the app's two TipTap editors -- the mail composer's body
 * and a meeting's notes -- asserting the two things a bare click-then-type
 * says nothing about: that the editor took focus, and that what was typed
 * arrived.
 *
 * `page.keyboard.type` goes to whatever the DOCUMENT has focused, and these
 * editors are ProseMirror views that mount in two steps: React renders
 * EditorContent's host element, and the view attaches to it afterwards,
 * bringing `editorProps.attributes` with it -- which is where BOTH the
 * `data-testid` these locators use and `contenteditable` come from (web:
 * components/mail/rich-text.tsx sets the attributes; prosemirror-view writes
 * `contenteditable` from `view.editable` onto that same element). A click
 * that lands outside that window, or a remount that replaces the element
 * under a caret already placed in it, focuses nothing -- and the keystrokes
 * then go to the body and are lost in silence. The bare shape had no way to
 * notice: the send/submit that follows posts an empty or half-typed
 * document, and the run fails a body assertion tests LATER, naming a step
 * that was never the problem.
 *
 * Hence the three gates. `contenteditable` is the view being attached and
 * editable at all; `toBeFocused` is the click having actually reached it
 * (a host element with no view is not focusable, so a click on one leaves
 * focus on the body); `toContainText` is the whole string having landed,
 * which is what catches the partial losses -- a view that takes focus mid-
 * type eats the LEADING characters and keeps the rest, and half a body reads
 * like a passing test everywhere except in what was sent.
 *
 * `click()` deliberately, not `focus()`: the click is what these journeys
 * already did and it puts the caret where a user's would (the composer opens
 * with a signature in the document), so this adds assertions without
 * changing a single action.
 *
 * The page comes from the locator rather than from a parameter, because the
 * one thing a caller could get wrong here is typing into one page's editor
 * with another page's keyboard -- e2e/mail.spec.ts drives two of them.
 *
 * TWO LIMITS, both deliberate. `toContainText` reads the DOM, not the
 * ProseMirror model: the browser writes the DOM first and the model catches
 * up in readDOMChange, so there is a sub-frame window where this passes and
 * getHTML() has not. The send/submit that follows every call closes it. And
 * `text` must be SINGLE-LINE PLAIN ASCII: toContainText normalises
 * whitespace, and StarterKit's input rules would turn a leading "- ", "1. "
 * or "# " into a list or heading, so the DOM would diverge from `text` and
 * fail here at a line that looks like an app bug.
 *
 * The prevention matters more than the detection: toHaveAttribute auto-waits,
 * so an editor whose view has not attached yet is WAITED IN rather than
 * merely caught.
 */
export async function typeIntoEditor(editor: Locator, text: string): Promise<void> {
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.click();
  await expect(editor).toBeFocused();
  await editor.page().keyboard.type(text);
  await expect(editor).toContainText(text);
}

/**
 * A held request, and whether it is STILL held.
 *
 * `holding()` is the fixture checking itself, and it is what makes every
 * assertion about an UNANSWERED surface worth anything: on a slow runner a hold
 * that expired before the read would leave such a test passing without ever
 * exercising the window, silently. Asserted rather than trusted, so the failure
 * says "the hold expired" instead of saying nothing at all.
 */
export interface Hold {
  /** A matching request has arrived and has not been let go. */
  holding: () => boolean;
  unroute: () => Promise<void>;
}

/**
 * DELAY THE FIRST REQUEST MATCHING `pattern`, AND ONLY THE FIRST.
 *
 * The shape is dictated by a failure this suite has already paid for: a
 * handler that parks every matching request and continues it later throws
 * "Route is already handled!" ASYNCHRONOUSLY if one is still parked when the
 * test ends, and Playwright reports that on whichever test is running by then
 * -- it took down two unrelated second-user journeys in v1.2.1's Task 1 and was
 * triaged as a flake both times. So: exactly one request is held, every later
 * one is continued immediately, both continues swallow their errors, and every
 * caller unroutes in a finally. Each caller must also wait on an effect of the
 * release before its test ends, so the held request is never still open at
 * teardown.
 *
 * IT LIVES HERE BECAUSE TWO FILES NOW HOLD A HOP OPEN -- rail-compose.spec.ts,
 * which wrote it, and list-loading.spec.ts. The scar above is the reason it is
 * shared rather than copied: a second hand-rolled parker would be one edit away
 * from reintroducing the flake this shape exists to prevent. (The per-file
 * `create` helpers are copied and stay copied; six lines of POST cannot drift
 * into a cross-file failure.)
 */
export function delayFirst(page: Page, pattern: string, ms: number): Promise<Hold> {
  let arrived = false;
  let released = false;
  const routed = page.route(pattern, async (route: Route) => {
    if (arrived) {
      await route.continue().catch(() => {});
      return;
    }
    arrived = true;
    await new Promise((resolve) => setTimeout(resolve, ms));
    released = true;
    await route.continue().catch(() => {});
  });
  return routed.then(() => ({
    holding: () => arrived && !released,
    unroute: async () => { await page.unroute(pattern).catch(() => {}); },
  }));
}
