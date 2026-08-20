import { describe, it, expect } from "vitest";
import type { MailThreadListItem } from "@conduit/shared";
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
  addressLabel,
  emptyThreadPages,
  FIRST_PAGE,
  flattenThreadPages,
  forwardBody,
  forwardSubject,
  mergeThreadPage,
  MESSAGE_FRAME_SANDBOX,
  messageFrameCsp,
  messageFrameSrcdoc,
  NO_SUBJECT_LABEL,
  replyRecipients,
  replySource,
  replySubject,
  subjectLabel,
  threadFilterKey,
} from "./mail-lib";

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

describe("subjectLabel", () => {
  it("renders the placeholder for a subject-less thread", () => {
    expect(subjectLabel("")).toBe(NO_SUBJECT_LABEL);
  });

  // The API stores '' for "no Subject header" and never the placeholder --
  // whitespace is the same absence, and must not render as a blank row.
  it("treats a whitespace-only subject as absent", () => {
    expect(subjectLabel("   ")).toBe(NO_SUBJECT_LABEL);
  });

  it("passes a real subject through", () => {
    expect(subjectLabel("Renewal quote")).toBe("Renewal quote");
  });
});

describe("addressLabel", () => {
  it("prefers the display name", () => {
    expect(addressLabel({ address: "alice@example.com", name: "Alice" })).toBe("Alice");
  });

  it("falls back to the bare address", () => {
    expect(addressLabel({ address: "alice@example.com", name: null })).toBe("alice@example.com");
    expect(addressLabel({ address: "alice@example.com" })).toBe("alice@example.com");
    expect(addressLabel({ address: "alice@example.com", name: "  " })).toBe("alice@example.com");
  });
});

describe("threadFilterKey", () => {
  it("is stable across key order", () => {
    expect(threadFilterKey({ unread: true, accountId: "a" }))
      .toBe(threadFilterKey({ accountId: "a", unread: true }));
  });

  it("ignores undefined values", () => {
    expect(threadFilterKey({ accountId: "a", unread: undefined })).toBe(threadFilterKey({ accountId: "a" }));
  });

  it("distinguishes different filter sets", () => {
    expect(threadFilterKey({ unread: true })).not.toBe(threadFilterKey({ unread: false }));
    expect(threadFilterKey({})).not.toBe(threadFilterKey({ unlinked: true }));
  });
});

describe("thread page accumulation", () => {
  // The merge and the flatten only ever read `id`; the rest of a list row is
  // irrelevant to them, so the fixtures say only what the code under test uses.
  const thread = (id: string) => ({ id }) as unknown as MailThreadListItem;

  it("collects pages in load order", () => {
    let pages = emptyThreadPages("k");
    pages = mergeThreadPage(pages, "k", undefined, [thread("a"), thread("b")]);
    pages = mergeThreadPage(pages, "k", "cursor-1", [thread("c")]);
    expect(flattenThreadPages(pages).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(pages.order).toEqual([FIRST_PAGE, "cursor-1"]);
  });

  // The whole point of keying on the filter set: a filter change must not
  // leave the previous filter's rows on screen behind the new first page.
  it("starts over when the filter key changes", () => {
    let pages = mergeThreadPage(emptyThreadPages("k"), "k", undefined, [thread("a")]);
    pages = mergeThreadPage(pages, "unread", undefined, [thread("z")]);
    expect(pages.key).toBe("unread");
    expect(pages.order).toEqual([FIRST_PAGE]);
    expect(flattenThreadPages(pages).map((item) => item.id)).toEqual(["z"]);
  });

  it("replaces a page when that page refetches", () => {
    let pages = mergeThreadPage(emptyThreadPages("k"), "k", undefined, [thread("a")]);
    pages = mergeThreadPage(pages, "k", "cursor-1", [thread("b")]);
    pages = mergeThreadPage(pages, "k", undefined, [thread("new"), thread("a")]);
    expect(flattenThreadPages(pages).map((item) => item.id)).toEqual(["new", "a", "b"]);
    expect(pages.order).toEqual([FIRST_PAGE, "cursor-1"]);
  });

  // Returning a fresh object for an unchanged page would set state on every
  // render, forever: the merge runs from a render effect.
  it("returns the same object when nothing changed", () => {
    const items = [thread("a")];
    const pages = mergeThreadPage(emptyThreadPages("k"), "k", undefined, items);
    expect(mergeThreadPage(pages, "k", undefined, items)).toBe(pages);
  });

  it("de-duplicates a thread that moved up to the first page", () => {
    let pages = mergeThreadPage(emptyThreadPages("k"), "k", undefined, [thread("a")]);
    pages = mergeThreadPage(pages, "k", "cursor-1", [thread("b"), thread("a")]);
    expect(flattenThreadPages(pages).map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("replySource", () => {
  const inbound = { id: "in", direction: "inbound" as const };
  const outbound = { id: "out", direction: "outbound" as const };

  it("answers the most recent inbound message", () => {
    expect(replySource([inbound, outbound, { id: "in2", direction: "inbound" as const }])?.id).toBe("in2");
  });

  it("falls back to the last message when the thread is all outbound", () => {
    expect(replySource([outbound, { id: "out2", direction: "outbound" as const }])?.id).toBe("out2");
  });

  it("has no answer for an empty thread", () => {
    expect(replySource([])).toBeUndefined();
  });
});

describe("replyRecipients", () => {
  const message = {
    fromAddr: "alice@example.com", fromName: "Alice",
    toAddrs: [{ address: "me@corp.example", name: "Me" }, { address: "bob@example.com", name: "Bob" }],
    ccAddrs: [{ address: "carol@example.com", name: null }],
    direction: "inbound" as const,
  };
  const own = ["me@corp.example"];

  it("replies to the sender alone", () => {
    expect(replyRecipients(message, { all: false, ownAddresses: own }))
      .toEqual({ to: [{ address: "alice@example.com", name: "Alice" }], cc: [] });
  });

  it("reply-all adds the other recipients", () => {
    const { to, cc } = replyRecipients(message, { all: true, ownAddresses: own });
    expect(to).toEqual([{ address: "alice@example.com", name: "Alice" }]);
    expect(cc.map((entry) => entry.address)).toEqual(["bob@example.com", "carol@example.com"]);
  });

  // The correctness-critical rule: cc'ing our own mailbox would mail the user
  // their own reply AND feed it back into the CRM as inbound mail.
  it("excludes every own address, case-insensitively and whitespace-tolerantly", () => {
    const { cc } = replyRecipients(
      {
        ...message,
        toAddrs: [{ address: "ME@Corp.Example", name: null }, { address: " other@corp.example ", name: null }],
        ccAddrs: [{ address: "bob@example.com", name: null }],
      },
      { all: true, ownAddresses: ["me@corp.example", "OTHER@corp.example "] },
    );
    expect(cc.map((entry) => entry.address)).toEqual(["bob@example.com"]);
  });

  it("never repeats the sender in cc", () => {
    const { cc } = replyRecipients(
      { ...message, ccAddrs: [{ address: "ALICE@example.com", name: null }] },
      { all: true, ownAddresses: own },
    );
    expect(cc.map((entry) => entry.address)).toEqual(["bob@example.com"]);
  });

  it("de-duplicates a recipient listed on both To and Cc", () => {
    const { cc } = replyRecipients(
      { ...message, ccAddrs: [{ address: "BOB@example.com", name: null }] },
      { all: true, ownAddresses: own },
    );
    expect(cc.map((entry) => entry.address)).toEqual(["bob@example.com"]);
  });

  // Replying to a conversation we started: the answer goes to whoever it was
  // sent to, never back to ourselves.
  it("addresses an outbound message's own recipients", () => {
    const { to, cc } = replyRecipients(
      { ...message, direction: "outbound" as const, fromAddr: "me@corp.example", fromName: "Me" },
      { all: true, ownAddresses: own },
    );
    expect(to.map((entry) => entry.address)).toEqual(["bob@example.com"]);
    expect(cc.map((entry) => entry.address)).toEqual(["carol@example.com"]);
  });

  it("tolerates an account list of none", () => {
    const { to } = replyRecipients(message, { all: false, ownAddresses: [] });
    expect(to).toEqual([{ address: "alice@example.com", name: "Alice" }]);
  });

  // The exclusion decides who is CC'd, never who the reply is TO. A colleague
  // whose mailbox this CRM also syncs is an ordinary correspondent, and
  // filtering them out of To left internal mail unaddressed (and Send
  // disabled).
  it("replies to a sender whose own mailbox this installation syncs", () => {
    const internal = {
      ...message,
      fromAddr: "colleague@corp.example", fromName: "Colleague",
      toAddrs: [{ address: "me@corp.example", name: "Me" }],
      ccAddrs: [],
    };
    const own = ["me@corp.example", "colleague@corp.example"];
    expect(replyRecipients(internal, { all: false, ownAddresses: own }).to)
      .toEqual([{ address: "colleague@corp.example", name: "Colleague" }]);
    const all = replyRecipients(internal, { all: true, ownAddresses: own });
    expect(all.to).toEqual([{ address: "colleague@corp.example", name: "Colleague" }]);
    // ...and the extras are still filtered: our own mailbox is not cc'd.
    expect(all.cc).toEqual([]);
  });

  it("falls back to the sender when our own message went only to ourselves", () => {
    const noteToSelf = {
      ...message,
      direction: "outbound" as const,
      fromAddr: "me@corp.example", fromName: "Me",
      toAddrs: [{ address: "me@corp.example", name: "Me" }],
      ccAddrs: [],
    };
    expect(replyRecipients(noteToSelf, { all: false, ownAddresses: own }).to)
      .toEqual([{ address: "me@corp.example", name: "Me" }]);
  });
});

describe("replySubject / forwardSubject", () => {
  it("prefixes once", () => {
    expect(replySubject("Invoice")).toBe("Re: Invoice");
    expect(replySubject("Re: Invoice")).toBe("Re: Invoice");
    expect(replySubject("re:Invoice")).toBe("re:Invoice");
    expect(forwardSubject("Invoice")).toBe("Fwd: Invoice");
    expect(forwardSubject("Fwd: Invoice")).toBe("Fwd: Invoice");
    expect(forwardSubject("Fw: Invoice")).toBe("Fw: Invoice");
  });

  it("handles a subject-less thread", () => {
    expect(replySubject("")).toBe("Re: ");
    expect(forwardSubject("  ")).toBe("Fwd: ");
  });
});

describe("forwardBody", () => {
  const message = {
    fromAddr: "alice@example.com", fromName: "Alice <the> Boss",
    toAddrs: [{ address: "me@corp.example", name: "Me" }],
    ccAddrs: [],
    direction: "inbound" as const,
    subject: "Renewal", sentAt: "2026-08-19T10:00:00.000Z",
    bodyHtml: "<p>Hello &amp; welcome</p>", bodyText: "Hello",
  };
  // A fixed formatter: the default reads the browser's locale, which is not
  // something a unit test should be asserting against.
  const at = () => "19 Aug 2026, 10:00";

  it("quotes the sanitized html under a header block", () => {
    const body = forwardBody(message, at);
    expect(body).toContain("---------- Forwarded message ----------");
    expect(body).toContain("From: Alice &lt;the&gt; Boss &lt;alice@example.com&gt;");
    expect(body).toContain("Date: 19 Aug 2026, 10:00");
    expect(body).toContain("Subject: Renewal");
    expect(body).toContain("To: Me &lt;me@corp.example&gt;");
    expect(body).toContain("<blockquote><p>Hello &amp; welcome</p></blockquote>");
  });

  it("omits the Cc line when there was none, and includes it when there was", () => {
    expect(forwardBody(message, at)).not.toContain("Cc:");
    expect(forwardBody({ ...message, ccAddrs: [{ address: "bob@example.com", name: null }] }, at))
      .toContain("Cc: bob@example.com");
  });

  it("escapes a text-only body and keeps its line breaks", () => {
    const body = forwardBody({ ...message, bodyHtml: null, bodyText: "line 1\nline <2>" }, at);
    expect(body).toContain("<blockquote><p>line 1<br>line &lt;2&gt;</p></blockquote>");
  });

  it("labels a subject-less original", () => {
    expect(forwardBody({ ...message, subject: "" }, at)).toContain(`Subject: ${NO_SUBJECT_LABEL}`);
  });
});

describe("messageFrameCsp", () => {
  it("blocks everything but same-origin images and inline styles by default", () => {
    expect(messageFrameCsp("https://crm.example", { remoteImages: false }))
      .toBe("default-src 'none'; img-src data: 'self' https://crm.example; style-src 'unsafe-inline'");
  });

  it("widens only img-src when remote images are allowed", () => {
    expect(messageFrameCsp("https://crm.example", { remoteImages: true }))
      .toBe("default-src 'none'; img-src data: 'self' https://crm.example https: http:; style-src 'unsafe-inline'");
  });

  it("omits an unknown origin rather than emitting an empty source", () => {
    expect(messageFrameCsp("", { remoteImages: false }))
      .toBe("default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'");
  });

  // Scripts are blocked by the sandbox (which grants no allow-scripts) AND by
  // this policy; no policy this builder emits may ever loosen that.
  it("never emits a script source of any kind", () => {
    for (const remoteImages of [true, false]) {
      const csp = messageFrameCsp("https://crm.example", { remoteImages });
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toMatch(/allow-scripts|script-src|unsafe-eval/);
    }
  });

  // A CSP `sandbox` directive would re-impose sandboxing from inside the
  // document and drop the popup flags the ATTRIBUTE grants, breaking every
  // link in every message (see MESSAGE_FRAME_SANDBOX).
  it("never emits a sandbox directive", () => {
    for (const remoteImages of [true, false]) {
      expect(messageFrameCsp("https://crm.example", { remoteImages })).not.toContain("sandbox");
    }
  });
});

describe("MESSAGE_FRAME_SANDBOX", () => {
  it("grants same origin and both popup flags", () => {
    expect(MESSAGE_FRAME_SANDBOX).toContain("allow-same-origin");
    expect(MESSAGE_FRAME_SANDBOX).toContain("allow-popups");
    expect(MESSAGE_FRAME_SANDBOX).toContain("allow-popups-to-escape-sandbox");
  });

  // The four that would turn a rendered message into an actor on this app's
  // own origin: run code, submit a form as the user, navigate the CRM out from
  // under them, or hold the tab with a dialog.
  it("never grants scripts, forms, top navigation or modals", () => {
    expect(MESSAGE_FRAME_SANDBOX).not.toMatch(/allow-scripts/);
    expect(MESSAGE_FRAME_SANDBOX).not.toMatch(/allow-forms/);
    expect(MESSAGE_FRAME_SANDBOX).not.toMatch(/allow-top-navigation/);
    expect(MESSAGE_FRAME_SANDBOX).not.toMatch(/allow-modals/);
  });
});

describe("messageFrameSrcdoc", () => {
  it("carries the policy in a meta tag and the body verbatim", () => {
    const csp = messageFrameCsp("https://crm.example", { remoteImages: false });
    const doc = messageFrameSrcdoc("<p>Hi</p>", csp);
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${csp}">`);
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
    expect(doc).toContain("<body><p>Hi</p></body>");
  });

  // A CSP is quoted with single quotes only, so it can never terminate the
  // double-quoted content attribute it sits in.
  it("emits a policy that cannot break out of its attribute", () => {
    expect(messageFrameCsp("https://crm.example", { remoteImages: true })).not.toContain('"');
  });
});
