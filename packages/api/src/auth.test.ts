import { describe, it, expect } from "vitest";
import { identityFromHeaders } from "./auth.js";

describe("identityFromHeaders", () => {
  it("reads the SSOwat identity headers", () => {
    expect(
      identityFromHeaders(
        {
          "ynh-user": "chris",
          "ynh-user-email": "chris@example.com",
          "ynh-user-fullname": "Chris Wilson",
        },
        null,
      ),
    ).toEqual({ username: "chris", email: "chris@example.com", fullName: "Chris Wilson" });
  });

  it("returns null email and fullName when only the username header is present", () => {
    expect(identityFromHeaders({ "ynh-user": "chris" }, null)).toEqual({
      username: "chris",
      email: null,
      fullName: null,
    });
  });

  it("treats empty header values as absent", () => {
    expect(
      identityFromHeaders(
        { "ynh-user": "chris", "ynh-user-email": "", "ynh-user-fullname": "  " },
        null,
      ),
    ).toEqual({ username: "chris", email: null, fullName: null });
  });

  it("returns null when no username header is present and no dev user is configured", () => {
    expect(identityFromHeaders({}, null)).toBeNull();
  });

  it("falls back to the configured dev user when the header is absent", () => {
    expect(identityFromHeaders({}, "devuser")).toEqual({
      username: "devuser",
      email: null,
      fullName: "devuser",
    });
  });

  it("prefers a real SSOwat header over the dev user", () => {
    expect(identityFromHeaders({ "ynh-user": "chris" }, "devuser")?.username).toBe("chris");
  });

  it("ignores an array-valued header rather than trusting the first entry", () => {
    expect(identityFromHeaders({ "ynh-user": ["chris", "attacker"] }, null)).toBeNull();
  });

  it("rejects a ynh-user value containing an embedded newline", () => {
    expect(identityFromHeaders({ "ynh-user": "chris\nX-Injected: 1" }, null)).toBeNull();
  });

  it("rejects a ynh-user value containing a tab character", () => {
    expect(identityFromHeaders({ "ynh-user": "chris\tattacker" }, null)).toBeNull();
  });

  it("rejects a control character in ynh-user-email while a valid ynh-user still resolves", () => {
    expect(
      identityFromHeaders({ "ynh-user": "chris", "ynh-user-email": "chris@example.com\n" }, null),
    ).toEqual({ username: "chris", email: null, fullName: null });
  });

  it("keeps ordinary internal spaces in a full name", () => {
    expect(
      identityFromHeaders({ "ynh-user": "chris", "ynh-user-fullname": "Chris Wilson" }, null),
    ).toEqual({ username: "chris", email: null, fullName: "Chris Wilson" });
  });

  it("keeps ordinary hyphens and apostrophes in a full name", () => {
    expect(
      identityFromHeaders({ "ynh-user": "amob", "ynh-user-fullname": "Anne-Marie O'Brien" }, null),
    ).toEqual({ username: "amob", email: null, fullName: "Anne-Marie O'Brien" });
  });

  it("does not fall back to the dev user when ynh-user is present but malformed (control character)", () => {
    expect(identityFromHeaders({ "ynh-user": "chris\nX-Injected: 1" }, "devuser")).toBeNull();
  });

  it("does not fall back to the dev user when ynh-user is present but empty/whitespace-only", () => {
    expect(identityFromHeaders({ "ynh-user": "   " }, "devuser")).toBeNull();
  });

  it("does not fall back to the dev user when ynh-user is literally empty", () => {
    expect(identityFromHeaders({ "ynh-user": "" }, "devuser")).toBeNull();
  });

  it("does not fall back to the dev user when ynh-user is present but array-valued", () => {
    expect(identityFromHeaders({ "ynh-user": ["chris", "attacker"] }, "devuser")).toBeNull();
  });

  it("rejects a ynh-user value containing NEL (a C1 control character)", () => {
    expect(identityFromHeaders({ "ynh-user": "chris\u0085" }, null)).toBeNull();
  });

  it("rejects a ynh-user value containing a zero-width space, which trim() would not strip", () => {
    expect(identityFromHeaders({ "ynh-user": "chris\u200B" }, null)).toBeNull();
  });

  it("rejects an RTL override in ynh-user-fullname while a valid ynh-user still resolves", () => {
    expect(
      identityFromHeaders(
        { "ynh-user": "chris", "ynh-user-fullname": "\u202EWilson" },
        null,
      ),
    ).toEqual({ username: "chris", email: null, fullName: null });
  });

  it("preserves a Persian full name containing ZWNJ, which is required for correct rendering", () => {
    const fullname = "\u0645\u06CC\u200C\u0631\u0648\u062F";
    const result = identityFromHeaders({ "ynh-user": "u1", "ynh-user-fullname": fullname }, null);
    expect(result?.fullName).toBe(fullname);
  });

  it("preserves an emoji sequence joined with ZWJ", () => {
    const fullname = "\u{1F468}\u200D\u{1F4BB}";
    const result = identityFromHeaders({ "ynh-user": "u2", "ynh-user-fullname": fullname }, null);
    expect(result?.fullName).toBe(fullname);
  });
});
