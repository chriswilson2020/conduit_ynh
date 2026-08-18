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
});
