import { describe, it, expect } from "vitest";
import { MAIL_AUTH_ERROR_PREFIX, MAIL_CONNECTION_ERROR_PREFIX } from "@conduit/shared";
import {
  dedupeRecipients,
  friendlyMailError,
  htmlIsBlank,
  isEmailLike,
  MAIL_AUTH_MESSAGE,
  MAIL_CONNECTION_MESSAGE,
  parseAddressToken,
  parseRecipientInput,
  sendFailureMessage,
  signatureBlock,
  substitutePlaceholders,
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
