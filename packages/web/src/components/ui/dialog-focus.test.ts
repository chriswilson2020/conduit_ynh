import { describe, it, expect } from "vitest";
import { dialogReturnTarget } from "./dialog-focus";

/**
 * The one decision behind every dialog's close, tested away from the DOM.
 *
 * `isConnected` is the only DOM property this needs, so the fixtures are plain
 * objects with that one field. Nothing here stands in for a browser: the
 * question is which of two candidates wins, and that is arithmetic. The wiring
 * -- that the hook is passed to `onCloseAutoFocus`, that openers capture, and
 * that the caret really lands where this says -- is e2e/dialog-focus.spec.ts's,
 * at 1280 and at 390.
 */

const fallback = { isConnected: true, name: "main" };

describe("dialogReturnTarget", () => {
  it("returns the control the dialog was opened from, when it is still there", () => {
    const trigger = { isConnected: true, name: "Edit" };
    expect(dialogReturnTarget(trigger, fallback)).toBe(trigger);
  });

  /**
   * The case `isConnected` exists for, and it is not a hypothetical: an SSE
   * update or another tab can retire any opener while its dialog sits open.
   * It is NOT what covers a control the dialog's own action retires -- that
   * one is still connected when this runs, measured at two call sites, and
   * `forget()` is what covers it.
   */
  it("falls back when the control has left the document", () => {
    const trigger = { isConnected: false, name: "Lose" };
    expect(dialogReturnTarget(trigger, fallback)).toBe(fallback);
  });

  /**
   * Nothing captured. A `?task=` deep link opens the task drawer on page load
   * with no opener anywhere, and the gantt's `aria-hidden` tap overlays pass
   * null on purpose rather than offer an element no caret should land on.
   */
  it("falls back when nothing was captured at all", () => {
    expect(dialogReturnTarget(null, fallback)).toBe(fallback);
  });

  /**
   * An honest null rather than the body. The caller focuses whatever comes
   * back and does nothing if that is null, so a page with no landmark to fall
   * back to keeps the old behaviour instead of pretending to fix it.
   */
  it("returns null when there is no fallback either", () => {
    expect(dialogReturnTarget({ isConnected: false, name: "gone" }, null)).toBeNull();
  });
});
