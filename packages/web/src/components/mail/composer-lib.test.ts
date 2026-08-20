import { describe, it, expect } from "vitest";
import { MAIL_AUTH_ERROR_PREFIX, MAIL_CONNECTION_ERROR_PREFIX } from "@conduit/shared";
import { ApiError } from "../../api";
import {
  attachmentTarget,
  composeErrorMessage,
  dedupeRecipients,
  friendlyMailError,
  htmlIsBlank,
  isEmailLike,
  MAIL_AUTH_MESSAGE,
  MAIL_CONNECTION_MESSAGE,
  parseAddressToken,
  parseRecipientInput,
  resolveRecipients,
  sendFailureMessage,
  signatureBlock,
  substitutePlaceholders,
  substitutePlaceholdersHtml,
  templateSubject,
} from "./composer-lib";

describe("friendlyMailError", () => {
  it("maps the auth prefix to an actionable message", () => {
    expect(friendlyMailError(`${MAIL_AUTH_ERROR_PREFIX} Invalid login`)).toBe(MAIL_AUTH_MESSAGE);
  });

  it("maps the connection prefix to an actionable message", () => {
    expect(friendlyMailError(`${MAIL_CONNECTION_ERROR_PREFIX} ECONNREFUSED`)).toBe(MAIL_CONNECTION_MESSAGE);
  });

  // An unclassifiable failure carries no prefix at all (see the shared
  // constants' doc comment) -- "neither" is an ordinary case, not an error.
  it("passes an unclassified error through unchanged", () => {
    expect(friendlyMailError("  mailbox is full  ")).toBe("mailbox is full");
  });

  it("does not treat a prefix-like substring as a classification", () => {
    expect(friendlyMailError("reconnection: dropped")).toBe("reconnection: dropped");
  });
});

describe("sendFailureMessage", () => {
  it("finds a classified prefix inside the 502's wrapping message", () => {
    expect(sendFailureMessage(`sending the message failed: ${MAIL_AUTH_ERROR_PREFIX} Invalid login`))
      .toBe(MAIL_AUTH_MESSAGE);
  });

  it("finds a connection failure inside the wrapping message", () => {
    expect(sendFailureMessage(`sending the message failed: ${MAIL_CONNECTION_ERROR_PREFIX} ETIMEDOUT`))
      .toBe(MAIL_CONNECTION_MESSAGE);
  });

  it("shows an unclassified failure as the server worded it", () => {
    expect(sendFailureMessage("sending the message failed: 550 relay denied"))
      .toBe("sending the message failed: 550 relay denied");
  });

  it("does not match a prefix glued to the middle of a word", () => {
    const message = "sending the message failed: xauth:broken";
    expect(sendFailureMessage(message)).toBe(message);
  });
});

describe("isEmailLike", () => {
  it("accepts an ordinary address", () => {
    expect(isEmailLike("alice@example.com")).toBe(true);
  });

  it("rejects a bare word", () => {
    expect(isEmailLike("alice")).toBe(false);
  });

  it("rejects a domain with no dot", () => {
    expect(isEmailLike("alice@localhost")).toBe(false);
  });

  it("rejects anything with whitespace in it", () => {
    expect(isEmailLike("alice @example.com")).toBe(false);
  });
});

describe("parseAddressToken", () => {
  it("parses a bare address", () => {
    expect(parseAddressToken(" alice@example.com ")).toEqual({ address: "alice@example.com" });
  });

  it("parses a display name with angle brackets", () => {
    expect(parseAddressToken("Alice Smith <alice@example.com>"))
      .toEqual({ address: "alice@example.com", name: "Alice Smith" });
  });

  it("strips quotes around a display name", () => {
    expect(parseAddressToken('"Smith, Alice" <alice@example.com>'))
      .toEqual({ address: "alice@example.com", name: "Smith, Alice" });
  });

  it("drops an empty display name rather than sending an empty string", () => {
    expect(parseAddressToken("<alice@example.com>")).toEqual({ address: "alice@example.com" });
  });

  it("returns null for a fragment with no usable address", () => {
    expect(parseAddressToken("Alice Smith")).toBeNull();
  });

  it("returns null when the angle brackets hold something that is not an address", () => {
    expect(parseAddressToken("Alice <not-an-address>")).toBeNull();
  });
});

describe("parseRecipientInput", () => {
  it("keeps the still-being-typed tail as the remainder", () => {
    const result = parseRecipientInput("alice@example.com, bob@exa");
    expect(result.tokens).toEqual([{ address: "alice@example.com" }]);
    expect(result.remainder).toBe(" bob@exa");
    expect(result.invalid).toEqual([]);
  });

  it("commits every token when the input ends on a separator", () => {
    const result = parseRecipientInput("alice@example.com,bob@example.com,");
    expect(result.tokens).toEqual([{ address: "alice@example.com" }, { address: "bob@example.com" }]);
    expect(result.remainder).toBe("");
  });

  it("splits on semicolons and newlines too", () => {
    const result = parseRecipientInput("alice@example.com;bob@example.com\ncarol@example.com,");
    expect(result.tokens.map((t) => t.address))
      .toEqual(["alice@example.com", "bob@example.com", "carol@example.com"]);
  });

  // A display name contains spaces, so spaces must NOT be separators.
  it("does not split a display name on its spaces", () => {
    const result = parseRecipientInput("Alice Smith <alice@example.com>,");
    expect(result.tokens).toEqual([{ address: "alice@example.com", name: "Alice Smith" }]);
  });

  it("reports a committed fragment that is not an address", () => {
    const result = parseRecipientInput("nonsense,alice@example.com,");
    expect(result.invalid).toEqual(["nonsense"]);
    expect(result.tokens).toEqual([{ address: "alice@example.com" }]);
  });

  it("ignores empty fragments from doubled separators", () => {
    const result = parseRecipientInput("alice@example.com,,");
    expect(result.tokens).toHaveLength(1);
    expect(result.invalid).toEqual([]);
  });
});

// The submit path's own view of a recipient line. The bug these pin: a
// message addressed to one chipped and one still-typed recipient used to go
// out to the first one only, because the draft was committed behind a timer
// that had not fired when Send read the committed array.
describe("resolveRecipients", () => {
  it("sends a chipped AND a typed-but-uncommitted recipient", () => {
    expect(resolveRecipients([{ address: "alice@example.com" }], "bob@example.com").recipients)
      .toEqual([{ address: "alice@example.com" }, { address: "bob@example.com" }]);
  });

  it("sends a typed-only recipient with no chips at all", () => {
    const resolved = resolveRecipients([], "bob@example.com");
    expect(resolved.recipients).toEqual([{ address: "bob@example.com" }]);
    expect(resolved.invalid).toEqual([]);
  });

  it("tolerates a draft the user already ended with a separator", () => {
    expect(resolveRecipients([], "bob@example.com,").recipients).toEqual([{ address: "bob@example.com" }]);
  });

  it("parses a display name in the pending draft", () => {
    expect(resolveRecipients([], "Bob Jones <bob@example.com>").recipients)
      .toEqual([{ address: "bob@example.com", name: "Bob Jones" }]);
  });

  it("reports an unusable pending fragment instead of dropping it silently", () => {
    const resolved = resolveRecipients([{ address: "alice@example.com" }], "nonsense");
    expect(resolved.invalid).toEqual(["nonsense"]);
    // The committed chips survive: the caller turns `invalid` into a
    // validation error rather than sending a partially-addressed message.
    expect(resolved.recipients).toEqual([{ address: "alice@example.com" }]);
  });

  it("leaves the committed list alone when nothing is being typed", () => {
    const resolved = resolveRecipients([{ address: "alice@example.com" }], "   ");
    expect(resolved.recipients).toEqual([{ address: "alice@example.com" }]);
    expect(resolved.invalid).toEqual([]);
  });

  it("does not duplicate a typed address that is already chipped", () => {
    expect(resolveRecipients([{ address: "alice@example.com" }], "ALICE@example.com").recipients)
      .toEqual([{ address: "alice@example.com" }]);
  });
});

describe("attachmentTarget", () => {
  it("prefers the deal over everything else", () => {
    expect(attachmentTarget({ dealId: "d", projectId: "p", contactId: "c", companyId: "co" }))
      .toEqual({ dealId: "d" });
  });

  it("falls back to the project", () => {
    expect(attachmentTarget({ projectId: "p", contactId: "c", companyId: "co" })).toEqual({ projectId: "p" });
  });

  it("falls back to the contact", () => {
    expect(attachmentTarget({ contactId: "c", companyId: "co" })).toEqual({ contactId: "c" });
  });

  it("falls back to the company", () => {
    expect(attachmentTarget({ companyId: "co" })).toEqual({ companyId: "co" });
  });

  // POST /api/files needs exactly one record id, so "no links" means the
  // attach control is disabled rather than an upload that 400s.
  it("returns null for an empty links object", () => {
    expect(attachmentTarget({})).toBeNull();
  });

  it("returns null when there are no links at all", () => {
    expect(attachmentTarget(undefined)).toBeNull();
  });
});

describe("composeErrorMessage", () => {
  it("maps a 502 smtp_failed reason to the classified message", () => {
    const error = new ApiError(
      `sending the message failed: ${MAIL_AUTH_ERROR_PREFIX} Invalid login`, 502, "smtp_failed",
    );
    expect(composeErrorMessage(error)).toBe(MAIL_AUTH_MESSAGE);
  });

  it("shows an unclassified smtp_failed reason as the server worded it", () => {
    const error = new ApiError("sending the message failed: 550 relay denied", 502, "smtp_failed");
    expect(composeErrorMessage(error)).toBe("sending the message failed: 550 relay denied");
  });

  it("passes any other ApiError through by its message", () => {
    expect(composeErrorMessage(new ApiError("mail account xyz is archived", 409, "archived")))
      .toBe("mail account xyz is archived");
  });

  it("handles a plain Error", () => {
    expect(composeErrorMessage(new Error("network down"))).toBe("network down");
  });

  it("handles something that is not an Error at all", () => {
    expect(composeErrorMessage("boom")).toBe("boom");
  });
});

describe("dedupeRecipients", () => {
  it("collapses the same address regardless of case, keeping the first entry", () => {
    expect(dedupeRecipients([
      { address: "alice@example.com", name: "Alice" },
      { address: "ALICE@example.com" },
      { address: "bob@example.com" },
    ])).toEqual([{ address: "alice@example.com", name: "Alice" }, { address: "bob@example.com" }]);
  });
});

describe("substitutePlaceholders", () => {
  it("substitutes every supported placeholder", () => {
    const out = substitutePlaceholders(
      "<p>Hi {{contact.name}} at {{company.name}}, - {{user.name}}</p>",
      { contactName: "Alice", companyName: "Acme", userName: "Chris" },
    );
    expect(out).toBe("<p>Hi Alice at Acme, - Chris</p>");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(substitutePlaceholders("{{ contact.name }}", { contactName: "Alice" })).toBe("Alice");
  });

  it("leaves an unresolved placeholder literal", () => {
    expect(substitutePlaceholders("Hi {{contact.name}}", {})).toBe("Hi {{contact.name}}");
  });

  it("treats a blank context value as unresolved", () => {
    expect(substitutePlaceholders("Hi {{contact.name}}", { contactName: "   " })).toBe("Hi {{contact.name}}");
  });

  it("leaves an unknown placeholder alone", () => {
    expect(substitutePlaceholders("{{deal.title}}", { contactName: "Alice" })).toBe("{{deal.title}}");
  });

  it("substitutes every occurrence, not just the first", () => {
    expect(substitutePlaceholders("{{user.name}} and {{user.name}}", { userName: "Chris" }))
      .toBe("Chris and Chris");
  });
});

// The body path splices values into MARKUP, so a record name containing a
// markup character has to survive as text rather than be eaten by the
// server's sanitizer (or, worse, become markup).
describe("substitutePlaceholdersHtml", () => {
  it("escapes angle brackets in a substituted name", () => {
    expect(substitutePlaceholdersHtml("<p>Hi {{contact.name}}</p>", { contactName: "Ben <ben@corp>" }))
      .toBe("<p>Hi Ben &lt;ben@corp&gt;</p>");
  });

  it("escapes an ampersand exactly once", () => {
    expect(substitutePlaceholdersHtml("<p>{{company.name}}</p>", { companyName: "Smith & Sons" }))
      .toBe("<p>Smith &amp; Sons</p>");
  });

  it("does not escape the template's own markup, only the values", () => {
    expect(substitutePlaceholdersHtml("<p><strong>{{user.name}}</strong></p>", { userName: "Chris" }))
      .toBe("<p><strong>Chris</strong></p>");
  });

  it("leaves an unresolved placeholder literal, same as the text path", () => {
    expect(substitutePlaceholdersHtml("<p>Hi {{contact.name}}</p>", {})).toBe("<p>Hi {{contact.name}}</p>");
  });

  it("leaves the subject path unescaped", () => {
    // The subject is a header value, not markup: escaping there would put a
    // literal "&lt;" in the user's subject line.
    expect(substitutePlaceholders("Hi {{contact.name}}", { contactName: "Ben <ben@corp>" }))
      .toBe("Hi Ben <ben@corp>");
  });
});

describe("templateSubject", () => {
  const context = { contactName: "Alice" };

  it("applies the template subject when composing fresh into an empty field", () => {
    expect(templateSubject("", "Hello {{contact.name}}", { isReply: false, context })).toBe("Hello Alice");
  });

  it("keeps the thread's subject on a reply", () => {
    expect(templateSubject("Re: Invoice", "Hello", { isReply: true, context })).toBe("Re: Invoice");
  });

  it("keeps a subject the user already typed", () => {
    expect(templateSubject("My own subject", "Hello", { isReply: false, context })).toBe("My own subject");
  });
});

describe("htmlIsBlank", () => {
  it("treats an empty editor document as blank", () => {
    expect(htmlIsBlank("<p></p>")).toBe(true);
  });

  it("treats a non-breaking space as blank", () => {
    expect(htmlIsBlank("<p>&nbsp;</p>")).toBe(true);
  });

  it("treats real text as not blank", () => {
    expect(htmlIsBlank("<p>Hello</p>")).toBe(false);
  });
});

describe("signatureBlock", () => {
  it("separates the signature from the body with an empty paragraph", () => {
    expect(signatureBlock("<p>Chris</p>")).toBe("<p></p><p>Chris</p>");
  });
});
