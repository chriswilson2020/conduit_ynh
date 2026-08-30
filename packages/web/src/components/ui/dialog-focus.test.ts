import { describe, it, expect } from "vitest";
import { dialogReturnTarget } from "./dialog-focus";

/**
 * The one decision behind every dialog's close, tested away from the DOM.
 *
 * This package's vitest environment is `node` and there is no testing-library
 * here, so a rule that lives inside a React hook has no unit-level check at
 * all -- which is why the hook is a thin wrapper around this function rather
 * than the other way round. The wiring (that the hook is actually passed to
 * `onCloseAutoFocus`, and that the caret really lands where this says) is
 * e2e/dialog-focus.spec.ts's, at 1280 and at 390.
 *
 * `isConnected` is the only DOM property this needs, so the fixtures are plain
 * objects with that one field. Nothing here is a stand-in for a browser: the
 * question is which of three candidates wins, and that is arithmetic.
 */

/** A stand-in for `document.body`, which is the "nothing had focus" answer. */
const body = { isConnected: true, name: "body" };
const fallback = { isConnected: true, name: "main" };

describe("dialogReturnTarget", () => {
  it("returns the control the dialog was opened from, when it is still there", () => {
    const trigger = { isConnected: true, name: "Edit" };
    expect(dialogReturnTarget(trigger, body, fallback)).toBe(trigger);
  });

  /**
   * The case the `isConnected` test exists for, and it is not a hypothetical:
   * pages/deal-detail.tsx's Lose button is unmounted by the very mutation its
   * own dialog submits, and an SSE update can retire any of them while the
   * dialog is merely open.
   */
  it("falls back when the control has left the document", () => {
    const trigger = { isConnected: false, name: "Lose" };
    expect(dialogReturnTarget(trigger, body, fallback)).toBe(fallback);
  });

  it("falls back when nothing was captured at all", () => {
    expect(dialogReturnTarget(null, body, fallback)).toBe(fallback);
  });

  /**
   * `document.activeElement` is `<body>` rather than null in a live document
   * with nothing focused, so "nothing was captured" arrives in two spellings
   * and this is the second. A `?task=` deep link opens the task drawer on page
   * load, with no opener anywhere: focusing `<body>` back would be a no-op
   * that lands exactly where the bug lands.
   */
  it("falls back when what was captured is the body itself", () => {
    expect(dialogReturnTarget(body, body, fallback)).toBe(fallback);
  });

  /**
   * An honest null rather than the body. The caller focuses whatever comes
   * back and does nothing if that is null, so a page with no landmark to fall
   * back to keeps the old behaviour instead of pretending to fix it.
   */
  it("returns null when there is no fallback either", () => {
    expect(dialogReturnTarget({ isConnected: false, name: "gone" }, body, null)).toBeNull();
  });
});
