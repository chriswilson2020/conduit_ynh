import { describe, it, expect } from "vitest";
import type {
  BulkThreadFailureReason, BulkThreadSkipReason, MailThreadListItem,
} from "@conduit/shared";
import { MAIL_AUTH_ERROR_PREFIX, MAIL_CONNECTION_ERROR_PREFIX } from "@conduit/shared";
import { ApiError, ResponseShapeError } from "../../api";
import {
  buildFolderRows,
  bulkActionBlocked,
  bulkErrorMessage,
  bulkOwnershipBlocked,
  bulkPendingLabel,
  BULK_TIMEOUT_MESSAGE,
  isThreadGone,
  NOT_OWNER_EXPLANATION,
  THREAD_GONE_MESSAGE,
  emptySelection,
  extendThreadSelection,
  messageIsInTrash,
  moveTargetPatch,
  newestDiscovery,
  selectedThreadIds,
  selectionForKey,
  selectionLabel,
  SELECT_ALL_CAP,
  summarizeBulkResult,
  toggleAllOnPage,
  toggleThreadSelected,
  type SidebarFolderInput,
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
  advanceThreadPages,
  cursorForKey,
  emptyThreadPages,
  FIRST_PAGE,
  flattenThreadPages,
  forwardBody,
  forwardSubject,
  hiddenChipLabel,
  mergeThreadPage,
  MESSAGE_FRAME_SANDBOX,
  messageFrameCsp,
  messageFrameSrcdoc,
  NO_SUBJECT_LABEL,
  replyRecipients,
  replySource,
  replySubject,
  showEarlierLabel,
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
    pages = mergeThreadPage(pages, "k", undefined, [thread("a"), thread("b")], "cursor-1");
    pages = mergeThreadPage(pages, "k", "cursor-1", [thread("c")], null);
    expect(flattenThreadPages(pages).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(pages.order).toEqual([FIRST_PAGE, "cursor-1"]);
  });

  // The whole point of keying on the filter set: a filter change must not
  // leave the previous filter's rows on screen behind the new first page.
  it("starts over when the filter key changes", () => {
    let pages = mergeThreadPage(emptyThreadPages("k"), "k", undefined, [thread("a")], null);
    pages = mergeThreadPage(pages, "unread", undefined, [thread("z")], null);
    expect(pages.key).toBe("unread");
    expect(pages.order).toEqual([FIRST_PAGE]);
    expect(flattenThreadPages(pages).map((item) => item.id)).toEqual(["z"]);
  });

  it("replaces a page when that page refetches", () => {
    let pages = mergeThreadPage(emptyThreadPages("k"), "k", undefined, [thread("a")], "cursor-1");
    pages = mergeThreadPage(pages, "k", "cursor-1", [thread("b")], null);
    pages = mergeThreadPage(pages, "k", undefined, [thread("new"), thread("a")], "cursor-1");
    expect(flattenThreadPages(pages).map((item) => item.id)).toEqual(["new", "a", "b"]);
    expect(pages.order).toEqual([FIRST_PAGE, "cursor-1"]);
  });

  // Returning a fresh object for an unchanged page would set state on every
  // render, forever: the merge runs from a render effect.
  it("returns the same object when nothing changed", () => {
    const items = [thread("a")];
    const pages = mergeThreadPage(emptyThreadPages("k"), "k", undefined, items, "cursor-1");
    expect(mergeThreadPage(pages, "k", undefined, items, "cursor-1")).toBe(pages);
  });

  it("does not return the same object when the server's nextCursor moved", () => {
    const items = [thread("a")];
    const pages = mergeThreadPage(emptyThreadPages("k"), "k", undefined, items, "cursor-1");
    expect(mergeThreadPage(pages, "k", undefined, items, null).nextCursor).toBeNull();
  });

  it("de-duplicates a thread that moved up to the first page", () => {
    let pages = mergeThreadPage(emptyThreadPages("k"), "k", undefined, [thread("a")], "cursor-1");
    pages = mergeThreadPage(pages, "k", "cursor-1", [thread("b"), thread("a")], null);
    expect(flattenThreadPages(pages).map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("thread page cursors", () => {
  const thread = (id: string) => ({ id }) as unknown as MailThreadListItem;

  it("hands a cursor back only to the key that issued it", () => {
    let pages = mergeThreadPage(emptyThreadPages("a"), "a", undefined, [thread("1")], "cursor-1");
    expect(cursorForKey(pages, "a")).toBeUndefined();
    pages = advanceThreadPages(pages, "a");
    expect(cursorForKey(pages, "a")).toBe("cursor-1");
    expect(cursorForKey(pages, "b")).toBeUndefined();
  });

  it("refuses to advance past the last page, or for another key", () => {
    const pages = mergeThreadPage(emptyThreadPages("a"), "a", undefined, [thread("1")], null);
    expect(advanceThreadPages(pages, "a")).toBe(pages);
    const more = mergeThreadPage(emptyThreadPages("a"), "a", undefined, [thread("1")], "cursor-1");
    expect(advanceThreadPages(more, "b")).toBe(more);
  });

  /**
   * THE REGRESSION (quality review, 20 Aug). Load a second page, toggle a
   * filter on, then toggle it back off. The returning key used to find the old
   * page-two cursor still sitting in the component's own state -- while the
   * accumulator had been reset by the intervening filter -- so the list
   * fetched page two, accumulated page two alone, and page ONE silently
   * disappeared. With the cursor living beside the key that issued it, the
   * returning key is page one by construction.
   */
  it("does not revive a cursor when a filter is toggled off again", () => {
    let pages = mergeThreadPage(emptyThreadPages("a"), "a", undefined, [thread("1")], "cursor-1");
    pages = advanceThreadPages(pages, "a");
    pages = mergeThreadPage(pages, "a", "cursor-1", [thread("2")], null);
    expect(flattenThreadPages(pages).map((item) => item.id)).toEqual(["1", "2"]);

    // Filter toggled ON: a key this record is not holding starts at page one...
    expect(cursorForKey(pages, "b")).toBeUndefined();
    pages = mergeThreadPage(pages, "b", undefined, [thread("9")], null);

    // ...and toggled back OFF, the original key is page one too -- NOT
    // "cursor-1", which is what used to lose page one.
    expect(cursorForKey(pages, "a")).toBeUndefined();
    pages = mergeThreadPage(pages, "a", cursorForKey(pages, "a"), [thread("1")], "cursor-1");
    expect(flattenThreadPages(pages).map((item) => item.id)).toEqual(["1"]);
    expect(pages.order).toEqual([FIRST_PAGE]);
  });

  // The same toggle, fast enough that the intervening filter's page one never
  // landed: the cursor IS handed back, but the pages it belongs to are still
  // there, so the worst case is re-fetching page two -- never a vanished page
  // one.
  it("keeps page one when the toggle beats the intervening fetch", () => {
    let pages = mergeThreadPage(emptyThreadPages("a"), "a", undefined, [thread("1")], "cursor-1");
    pages = advanceThreadPages(pages, "a");
    pages = mergeThreadPage(pages, "a", "cursor-1", [thread("2")], null);
    expect(cursorForKey(pages, "a")).toBe("cursor-1");
    expect(flattenThreadPages(pages).map((item) => item.id)).toEqual(["1", "2"]);
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

  // The other half of the html guard: a stored body_html of "" is as absent as
  // null (both are ordinary for a text-only message), and quoting an empty
  // blockquote would drop the text the message actually carried.
  it("falls back to the text body for an empty html body", () => {
    const body = forwardBody({ ...message, bodyHtml: "", bodyText: "plain only" }, at);
    expect(body).toContain("<blockquote><p>plain only</p></blockquote>");
  });
});

describe("showEarlierLabel", () => {
  const detail = (truncated: boolean, totalMessages: number, rendered: number) => ({
    truncated, totalMessages, messages: Array.from({ length: rendered }),
  });

  it("derives N from the visible total minus the rendered page", () => {
    expect(showEarlierLabel(detail(true, 51, 50))).toBe("Show earlier messages (1 more)");
    expect(showEarlierLabel(detail(true, 80, 50))).toBe("Show earlier messages (30 more)");
  });

  it("offers nothing for an untruncated payload, whatever the counts say", () => {
    expect(showEarlierLabel(detail(false, 50, 50))).toBeNull();
    // The uncapped (?all=true) response: everything rendered, truncated
    // false -- the control must disappear once it has done its job.
    expect(showEarlierLabel(detail(false, 80, 80))).toBeNull();
  });

  it("offers nothing when a truncated payload has no missing messages to show", () => {
    // Defensive: the server never says truncated without a remainder, but a
    // "(0 more)" button would be a lie worth guarding against anyway.
    expect(showEarlierLabel(detail(true, 50, 50))).toBeNull();
  });
});

describe("hiddenChipLabel", () => {
  const now = new Date("2026-08-21T12:00:00.000Z");

  it("labels a hidden row with the viewer's own filing moment, relatively", () => {
    expect(hiddenChipLabel("2026-08-21T10:00:00.000Z", now)).toBe("Hidden 2h ago");
    expect(hiddenChipLabel("2026-08-19T10:00:00.000Z", now)).toBe("Hidden 2d ago");
  });

  it("renders no chip for a null hiddenAt -- every default-list row", () => {
    expect(hiddenChipLabel(null, now)).toBeNull();
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

  // Belt and braces for the line above: the safety is a property of the CALLER
  // (messageFrameCsp's grammar), so the splice escapes double quotes anyway.
  it("escapes a double quote a future policy builder might emit", () => {
    const doc = messageFrameSrcdoc("<p>Hi</p>", 'default-src "none"');
    expect(doc).toContain('content="default-src &quot;none&quot;">');
    expect(doc).toContain("<body><p>Hi</p></body>");
  });

  // The other splice, by contrast, is markup on purpose: escaping a sanitized
  // body would render the mail as its own source.
  it("does not escape the body", () => {
    expect(messageFrameSrcdoc('<p class="x">Hi &amp; bye</p>', "default-src 'none'"))
      .toContain('<body><p class="x">Hi &amp; bye</p></body>');
  });
});

// ---------------------------------------------------------------------------
// Phase 4.1: selection model, folder sidebar shaping, bulk result summaries
// ---------------------------------------------------------------------------

describe("thread selection", () => {
  const KEY = '[["folder","INBOX"]]';
  const OTHER = '[["folder","Archive"]]';
  const rows = ["a", "b", "c", "d", "e"];

  it("starts empty and toggles one row at a time", () => {
    let selection = emptySelection(KEY);
    expect(selection.ids.size).toBe(0);
    selection = toggleThreadSelected(selection, KEY, "b");
    expect([...selection.ids]).toEqual(["b"]);
    selection = toggleThreadSelected(selection, KEY, "d");
    expect([...selection.ids].sort()).toEqual(["b", "d"]);
    selection = toggleThreadSelected(selection, KEY, "b");
    expect([...selection.ids]).toEqual(["d"]);
  });

  // The whole clear-on-filter-change rule, and the reason it is a property of
  // the data structure rather than an effect: a selection is only ever handed
  // back to the key it was made under.
  it("is empty for any key it was not made under", () => {
    const selection = toggleThreadSelected(emptySelection(KEY), KEY, "b");
    expect(selectionForKey(selection, KEY).ids.size).toBe(1);
    expect(selectionForKey(selection, OTHER).ids.size).toBe(0);
    expect(selectionForKey(selection, OTHER).key).toBe(OTHER);
  });

  it("drops a stale selection when a mutation arrives under a new key", () => {
    const selection = toggleThreadSelected(emptySelection(KEY), KEY, "b");
    const next = toggleThreadSelected(selection, OTHER, "c");
    expect([...next.ids]).toEqual(["c"]);
    expect(next.key).toBe(OTHER);
  });

  it("shift-extends from the anchor in visible row order, in both directions", () => {
    let selection = toggleThreadSelected(emptySelection(KEY), KEY, "d");
    selection = extendThreadSelection(selection, KEY, "b", rows);
    expect([...selection.ids].sort()).toEqual(["b", "c", "d"]);
    // The anchor stays put, so a second shift-click re-ranges from the same
    // origin rather than from the last row touched.
    selection = extendThreadSelection(selection, KEY, "e", rows);
    expect([...selection.ids].sort()).toEqual(["b", "c", "d", "e"]);
    expect(selection.anchor).toBe("d");
  });

  it("shift-clicks with no anchor, or on a row no longer visible, behave as a plain toggle", () => {
    const fresh = extendThreadSelection(emptySelection(KEY), KEY, "c", rows);
    expect([...fresh.ids]).toEqual(["c"]);
    const anchored = toggleThreadSelected(emptySelection(KEY), KEY, "a");
    expect([...extendThreadSelection(anchored, KEY, "zz", rows).ids].sort()).toEqual(["a", "zz"]);
  });

  it("selects every visible row, and clears when they are all already selected", () => {
    let selection = toggleAllOnPage(emptySelection(KEY), KEY, rows);
    expect([...selection.ids].sort()).toEqual(rows);
    selection = toggleAllOnPage(selection, KEY, rows);
    expect(selection.ids.size).toBe(0);
    expect(selection.anchor).toBeNull();
  });

  // The route caps trash/archive at 50 threads per request, so select-all
  // stops there rather than building a selection the server would 400.
  it("caps select-all at the move cap, and says what was asked for", () => {
    const many = Array.from({ length: 120 }, (_value, index) => `t${index}`);
    const selection = toggleAllOnPage(emptySelection(KEY), KEY, many);
    expect(selection.ids.size).toBe(SELECT_ALL_CAP);
    expect(selection.ids.has("t0")).toBe(true);
    expect(selection.ids.has(`t${SELECT_ALL_CAP}`)).toBe(false);
    // The truncation is REPORTED, not silent: 50 of the 120 asked for.
    expect(selection.capped).toBe(120);
  });

  // The cap belongs to the REQUEST, so it applies to the total -- not to the
  // page, which composing over an existing selection would otherwise exceed.
  it("composes select-all over an existing selection without passing the cap", () => {
    const many = Array.from({ length: 120 }, (_value, index) => `t${index}`);
    // 40 rows ticked from the far end of the list, then "select all".
    let selection = emptySelection(KEY);
    for (const id of many.slice(80, 120)) selection = toggleThreadSelected(selection, KEY, id);
    expect(selection.ids.size).toBe(40);
    selection = toggleAllOnPage(selection, KEY, many);
    expect(selection.ids.size).toBe(SELECT_ALL_CAP);
    // The 40 that were already ticked are still ticked -- the gesture ADDS.
    expect(selection.ids.has("t119")).toBe(true);
    expect(selection.capped).toBe(120);
  });

  it("caps a shift-range too, keeping the rows nearest the anchor", () => {
    const many = Array.from({ length: 120 }, (_value, index) => `t${index}`);
    let selection = toggleThreadSelected(emptySelection(KEY), KEY, "t10");
    selection = extendThreadSelection(selection, KEY, "t119", many);
    expect(selection.ids.size).toBe(SELECT_ALL_CAP);
    // Taken from the anchor outwards: t10 through t59, not the other end.
    expect(selection.ids.has("t10")).toBe(true);
    expect(selection.ids.has(`t${10 + SELECT_ALL_CAP - 1}`)).toBe(true);
    expect(selection.ids.has(`t${10 + SELECT_ALL_CAP}`)).toBe(false);
    expect(selection.capped).toBe(110);
  });

  it("ranges backwards from the anchor keep the rows nearest it as well", () => {
    const many = Array.from({ length: 120 }, (_value, index) => `t${index}`);
    let selection = toggleThreadSelected(emptySelection(KEY), KEY, "t119");
    selection = extendThreadSelection(selection, KEY, "t0", many);
    expect(selection.ids.size).toBe(SELECT_ALL_CAP);
    expect(selection.ids.has("t119")).toBe(true);
    expect(selection.ids.has("t70")).toBe(true);
    expect(selection.ids.has("t69")).toBe(false);
  });

  it("refuses one tick past the cap rather than swapping a row out, and reports it", () => {
    const many = Array.from({ length: 60 }, (_value, index) => `t${index}`);
    let selection = toggleAllOnPage(emptySelection(KEY), KEY, many);
    expect(selection.ids.size).toBe(SELECT_ALL_CAP);
    selection = toggleThreadSelected(selection, KEY, "t59");
    expect(selection.ids.size).toBe(SELECT_ALL_CAP);
    expect(selection.ids.has("t59")).toBe(false);
    expect(selection.ids.has("t0")).toBe(true);
    expect(selection.capped).toBe(SELECT_ALL_CAP + 1);
    // Unticking always works, and clears the notice with it.
    selection = toggleThreadSelected(selection, KEY, "t0");
    expect(selection.ids.size).toBe(SELECT_ALL_CAP - 1);
    expect(selection.capped).toBeNull();
  });

  it("leaves `capped` null for gestures that fit", () => {
    let selection = toggleAllOnPage(emptySelection(KEY), KEY, rows);
    expect(selection.capped).toBeNull();
    selection = toggleThreadSelected(emptySelection(KEY), KEY, "b");
    expect(selection.capped).toBeNull();
    expect(extendThreadSelection(selection, KEY, "e", rows).capped).toBeNull();
  });

  it("returns the selected ids in visible order, dropping rows that have gone", () => {
    let selection = toggleThreadSelected(emptySelection(KEY), KEY, "e");
    selection = toggleThreadSelected(selection, KEY, "a");
    selection = toggleThreadSelected(selection, KEY, "gone");
    expect(selectedThreadIds(selection, KEY, rows)).toEqual(["a", "e"]);
    expect(selectedThreadIds(selection, OTHER, rows)).toEqual([]);
  });
});

describe("bulkActionBlocked", () => {
  it("permits a selection inside each action's own cap", () => {
    expect(bulkActionBlocked("archive", 50)).toBeNull();
    expect(bulkActionBlocked("trash", 1)).toBeNull();
    expect(bulkActionBlocked("hide", 200)).toBeNull();
  });

  it("refuses more threads than the server would accept, per action", () => {
    expect(bulkActionBlocked("archive", 51)).toContain("50");
    expect(bulkActionBlocked("trash", 51)).toContain("50");
    expect(bulkActionBlocked("hide", 201)).toContain("200");
  });
});

// Phase 4.2's owner-only move rights, as the bulk bar's disabled-with-reason
// state. The reason renders as TEXT on the bar (the 4.1 blocked-note
// pattern): a title on a disabled button reaches neither a touch screen nor
// a screen reader.
describe("bulkOwnershipBlocked", () => {
  it("permits the moves when every selected thread is owned", () => {
    expect(bulkOwnershipBlocked("archive", 0)).toBeNull();
    expect(bulkOwnershipBlocked("trash", 0)).toBeNull();
  });

  it("blocks Archive and Trash when any selected thread is unowned, counting them", () => {
    expect(bulkOwnershipBlocked("archive", 1))
      .toBe(`1 selected conversation is in a mailbox you don't own: ${NOT_OWNER_EXPLANATION}.`);
    expect(bulkOwnershipBlocked("trash", 3))
      .toBe(`3 selected conversations are in a mailbox you don't own: ${NOT_OWNER_EXPLANATION}.`);
  });

  // The spec's Move rights line, verbatim -- shared with the per-thread
  // not_owner note so the two surfaces cannot phrase one rule two ways. It
  // must name the rule, not "your account", and must not send the viewer to
  // Settings: the mailbox can be another user's.
  it("phrases the rule as the spec words it, with no Settings pointer", () => {
    expect(NOT_OWNER_EXPLANATION)
      .toBe("only the mailbox owner can archive or trash \u2014 Hide in CRM is available to everyone");
    expect(NOT_OWNER_EXPLANATION).not.toContain("your account");
    expect(NOT_OWNER_EXPLANATION).not.toContain("Settings");
  });

  // Hide in CRM is exactly what every viewer keeps -- an unowned selection
  // must never grey it out.
  it("never blocks hide", () => {
    expect(bulkOwnershipBlocked("hide", 50)).toBeNull();
  });
});

// The conversation pane's "gone" branch: the detail route's 404 is deliberately
// indistinguishable across nonexistent, deleted and flipped-to-private (the
// accepted stale-pane window -- a flip's SSE frame carries no per-thread key,
// so an open pane meets the 404 at its next refetch). Status-based, never
// message-text-based.
describe("isThreadGone", () => {
  it("recognises the detail route's 404, by status alone", () => {
    expect(isThreadGone(new ApiError("mail thread x not found", 404, "not_found"))).toBe(true);
    // Whatever the message says: the branch must not read text.
    expect(isThreadGone(new ApiError("anything at all", 404, "unknown"))).toBe(true);
  });

  it("does not swallow other failures into the calm state", () => {
    expect(isThreadGone(new ApiError("boom", 500, "internal"))).toBe(false);
    expect(isThreadGone(new ApiError("nope", 403, "forbidden"))).toBe(false);
    expect(isThreadGone(new Error("network down"))).toBe(false);
    expect(isThreadGone(undefined)).toBe(false);
  });

  // One sentence, no cause: copy that guessed "deleted" or "unshared" would
  // un-blur the indistinguishable 404.
  it("keeps the gone copy cause-free", () => {
    expect(THREAD_GONE_MESSAGE).toBe("This conversation is no longer available.");
    expect(THREAD_GONE_MESSAGE).not.toContain("deleted");
    expect(THREAD_GONE_MESSAGE).not.toContain("private");
  });
});

describe("buildFolderRows", () => {
  const NOW = "2026-08-20T10:00:00.000Z";
  const THEN = "2026-08-19T10:00:00.000Z";
  const folder = (
    name: string,
    extra: Partial<SidebarFolderInput> = {},
  ): SidebarFolderInput => ({
    folder: name, specialUse: null, syncEnabled: true, selectable: true,
    lastDiscoveredAt: NOW, ...extra,
  });

  it("orders INBOX first, then the classified folders around the ordinary ones", () => {
    const rows = buildFolderRows(
      [
        folder("Zebra"), folder("Trash", { specialUse: "trash", syncEnabled: false }),
        folder("Apples"), folder("INBOX"), folder("Sent", { specialUse: "sent" }),
        folder("Archive", { specialUse: "archive" }), folder("Junk", { specialUse: "junk", syncEnabled: false }),
        folder("Drafts", { specialUse: "drafts" }),
      ],
      [{ folder: "Trash", count: 2 }, { folder: "Junk", count: 1 }],
      { trashFolder: "Trash" },
    );
    expect(rows.map((row) => row.folder))
      .toEqual(["INBOX", "Sent", "Drafts", "Archive", "Apples", "Zebra", "Junk", "Trash"]);
  });

  // The join is BY NAME against this account's folder rows: a count row for a
  // folder this account does not have (another account's, or another user's --
  // the counts are not owner-scoped) is not a folder to render.
  it("joins counts by name and ignores count rows with no folder of their own", () => {
    const rows = buildFolderRows(
      [folder("INBOX"), folder("Work")],
      [{ folder: "INBOX", count: 4 }, { folder: "Somebody Else", count: 9 }],
      { trashFolder: null },
    );
    expect(rows.map((row) => [row.folder, row.unread])).toEqual([["INBOX", 4], ["Work", 0]]);
  });

  it("hides folders the picker switched off, and unselectable ones entirely", () => {
    const rows = buildFolderRows(
      [folder("INBOX"), folder("Off", { syncEnabled: false }), folder("Node", { selectable: false })],
      [],
      { trashFolder: null },
    );
    expect(rows.map((row) => row.folder)).toEqual(["INBOX"]);
  });

  // Two carve-outs, both for mail that would otherwise be unreachable: the
  // account's Trash is where this CRM's own Trash action files rows (even
  // unsynced), and any folder still holding unread mail must stay clickable.
  it("keeps a switched-off Trash, and any switched-off folder holding unread mail", () => {
    const rows = buildFolderRows(
      [
        folder("INBOX"), folder("Trash", { specialUse: "trash", syncEnabled: false }),
        folder("Junk", { specialUse: "junk", syncEnabled: false }),
        folder("Quiet", { syncEnabled: false }),
      ],
      [{ folder: "Junk", count: 3 }],
      { trashFolder: "Trash" },
    );
    expect(rows.map((row) => row.folder)).toEqual(["INBOX", "Junk", "Trash"]);
  });

  // Byte-exact, like every other folder comparison in this app.
  it("matches the trash target byte for byte", () => {
    const rows = buildFolderRows(
      [folder("Trash", { syncEnabled: false })], [], { trashFolder: "trash" },
    );
    expect(rows).toEqual([]);
  });

  // Stale = not re-stamped by the account's most recent discovery pass, which
  // is exactly what a folder that vanished from the server looks like.
  it("drops a vanished folder, unless it still holds unread mail", () => {
    const rows = buildFolderRows(
      [folder("INBOX"), folder("Gone", { lastDiscoveredAt: THEN }), folder("Ghost", { lastDiscoveredAt: THEN })],
      [{ folder: "Ghost", count: 2 }],
      { trashFolder: null },
    );
    expect(rows.map((row) => [row.folder, row.stale])).toEqual([["INBOX", false], ["Ghost", true]]);
  });

  // THE TRASH CARVE-OUT OUTRANKS THE STALE DROP. A Trash target that vanished
  // from the server and holds no unread mail is the one row that must survive
  // both rules: this CRM's own Trash action files mail there, and a rail with no
  // entry for it is a rail that hides mail the app itself moved.
  it("keeps a vanished, unsynced, zero-unread Trash target -- marked as gone", () => {
    const rows = buildFolderRows(
      [
        folder("INBOX"),
        folder("Trash", { specialUse: "trash", syncEnabled: false, lastDiscoveredAt: THEN }),
        folder("Gone", { lastDiscoveredAt: THEN }),
      ],
      [],
      { trashFolder: "Trash" },
    );
    expect(rows.map((row) => [row.folder, row.stale, row.unread]))
      .toEqual([["INBOX", false, 0], ["Trash", true, 0]]);
  });

  it("treats a single discovery moment as nothing being stale", () => {
    const rows = buildFolderRows([folder("INBOX", { lastDiscoveredAt: THEN })], [], { trashFolder: null });
    expect(rows.map((row) => row.stale)).toEqual([false]);
  });
});

describe("newestDiscovery", () => {
  it("is the latest moment across the set, and empty for an empty one", () => {
    expect(newestDiscovery([
      { lastDiscoveredAt: "2026-08-19T10:00:00.000Z" },
      { lastDiscoveredAt: "2026-08-20T10:00:00.000Z" },
      { lastDiscoveredAt: "2026-08-01T10:00:00.000Z" },
    ])).toBe("2026-08-20T10:00:00.000Z");
    expect(newestDiscovery([])).toBe("");
  });
});

describe("summarizeBulkResult", () => {
  const ok = (threadId: string) => ({ threadId, ok: true });
  const skip = (threadId: string, reason: BulkThreadSkipReason) =>
    ({ threadId, ok: true, skipped: true, reason });
  const fail = (threadId: string, reason: BulkThreadFailureReason, error = "nope") =>
    ({ threadId, ok: false, error, reason });

  it("counts the three outcomes apart in the headline", () => {
    const summary = summarizeBulkResult("archive", [
      ok("1"), ok("2"), skip("3", "already_in_target"), fail("4", "no_sync"),
    ]);
    expect(summary).toMatchObject({ moved: 2, skipped: 1, failed: 1 });
    expect(summary.headline).toBe("2 archived, 1 skipped, 1 failed.");
  });

  // The one the brief pins: "nothing happened" must not read like "done".
  it("says nothing happened when nothing did", () => {
    const summary = summarizeBulkResult("archive", [
      skip("1", "already_in_target"), skip("2", "out_of_scope"),
    ]);
    expect(summary.moved).toBe(0);
    expect(summary.headline).toBe("Nothing archived, 2 skipped.");
    // already_in_target and out_of_scope are the quiet pair: counted, never
    // explained -- there is nothing for the user to do about either.
    expect(summary.notes).toEqual([]);
  });

  it("uses the action's own verb", () => {
    expect(summarizeBulkResult("trash", [ok("1")]).headline).toBe("1 moved to Trash.");
    expect(summarizeBulkResult("hide", [ok("1"), ok("2")]).headline).toBe("2 hidden.");
  });

  // Every branch keys off the `reason` CODE. Nothing here may ever match on
  // the free-text `error`, which is display-only (the house rule).
  it("explains each actionable reason once, with its count", () => {
    const summary = summarizeBulkResult("trash", [
      fail("1", "no_sync"), fail("2", "no_sync"),
      fail("3", "no_target"), fail("4", "not_found"),
      skip("5", "awaiting_reconciliation"), skip("6", "archived_account"),
    ]);
    const notes = summary.notes.join(" | ");
    expect(summary.notes).toHaveLength(5);
    // Both of no_sync's causes, not just the transient one: the code means
    // "no running sync loop", which covers a paused or errored account too.
    expect(notes).toContain("2 could not be moved: that mail account is not syncing right now");
    expect(notes).toContain("reconnecting or paused");
    expect(notes).toContain("no Trash folder is set");
    // "could not be found", never "deleted"/"no longer exist": since 4.2 the
    // same code also describes a thread whose account went private
    // mid-session, and the route's 404 is indistinguishable BY DESIGN --
    // copy that claimed deletion would un-blur that line.
    expect(notes).toContain("could not be found");
    expect(notes).toContain("after the next sync pass");
    expect(notes).toContain("archived mail account");
    // no_target is fixed in the viewer's own Settings, so the summary links.
    expect(summary.settingsLink).toBe(true);
  });

  // REASON_NOTES' insertion order IS the display order ("most actionable
  // first"), and this is the assertion that keeps that load-bearing: the
  // per-reason tests above are deliberately order-independent (toContain over
  // a join), so without this a silent reordering of the table would ship
  // unnoticed. One of each noted reason, fed in scrambled, expected in table
  // order -- which also pins every singular form exactly ("was refused",
  // "belongs to").
  it("renders the notes in the table's display order, failures before skips", () => {
    const summary = summarizeBulkResult("trash", [
      skip("1", "not_owner"), fail("2", "not_found"),
      skip("3", "archived_account"), fail("4", "server_refused", "TRYCREATE"),
      skip("5", "awaiting_reconciliation"), fail("6", "no_target"),
      fail("7", "no_sync"),
    ]);
    expect(summary.notes).toEqual([
      "1 could not be moved: that mail account is not syncing right now"
      + " \u2014 it may be reconnecting or paused.",
      "1 could not be moved: no Trash folder is set for that account yet.",
      "1 could not be found \u2014 the list has been refreshed.",
      "1 was refused by the mail server: TRYCREATE.",
      "1 will complete after the next sync pass.",
      "1 belongs to an archived mail account"
      + " \u2014 its mail can be moved again once its owner unarchives it.",
      "1 skipped: only the mailbox owner can archive or trash"
      + " \u2014 Hide in CRM is available to everyone.",
    ]);
  });

  // Phase 4.2: the owner-only move rule, in the spec's own words. The skip
  // can arrive AFTER an enabled Archive click (ownedByViewer is thread-global
  // while moves are folder-scoped), so this note is the click's explanation,
  // not just decoration on a state the UI already prevented.
  it("explains a not_owner skip with the move-rights sentence", () => {
    const summary = summarizeBulkResult("archive", [skip("1", "not_owner"), skip("2", "not_owner")]);
    expect(summary.headline).toBe("Nothing archived, 2 skipped.");
    expect(summary.notes).toEqual([
      "2 skipped: only the mailbox owner can archive or trash"
      + " \u2014 Hide in CRM is available to everyone.",
    ]);
    // Another user's sharing is not fixable in the viewer's Settings.
    expect(summary.settingsLink).toBe(false);
  });

  // archived_account can describe someone ELSE'S mailbox since 4.2 (it
  // outranks not_owner), so its note must neither say "your account" nor
  // send the viewer to their own Settings -- and the Settings link must not
  // fire for it either.
  it("keeps the archived_account note neutral about whose account it is", () => {
    const summary = summarizeBulkResult("trash", [skip("1", "archived_account")]);
    const note = summary.notes[0] ?? "";
    expect(note).toContain("archived mail account");
    expect(note).toContain("its owner");
    expect(note).not.toContain("your");
    expect(note).not.toContain("Settings");
    expect(summary.settingsLink).toBe(false);
  });

  it("names the Archive folder in a no_target note for an archive action", () => {
    const summary = summarizeBulkResult("archive", [fail("1", "no_target")]);
    expect(summary.notes[0]).toContain("no Archive folder is set");
  });

  it("shows the server's own refusal text, capped and de-duplicated", () => {
    const summary = summarizeBulkResult("trash", [
      fail("1", "server_refused", "TRYCREATE"), fail("2", "server_refused", "TRYCREATE"),
      fail("3", "server_refused", "over quota"),
    ]);
    const note = summary.notes[0] ?? "";
    expect(note).toContain("3 were refused by the mail server");
    expect(note).toContain("TRYCREATE");
    expect(note).toContain("over quota");
    // The identical refusal is shown once, not once per thread.
    expect(note.split("TRYCREATE")).toHaveLength(2);
  });

  it("does not point at Settings for reasons Settings cannot fix", () => {
    expect(summarizeBulkResult("trash", [fail("1", "server_refused", "no")]).settingsLink).toBe(false);
  });

  // One response can carry fifty different sentences from a mail server having
  // a bad day, and each of them can be a paragraph. Both bounds are enforced.
  it("shows at most three distinct refusals, each truncated with an ellipsis", () => {
    const long = `${"x".repeat(200)}`;
    const summary = summarizeBulkResult("trash", [
      fail("1", "server_refused", long),
      fail("2", "server_refused", "second"),
      fail("3", "server_refused", "third"),
      fail("4", "server_refused", "fourth"),
      fail("5", "server_refused", "fifth"),
    ]);
    const note = summary.notes[0] ?? "";
    // The count is honest about all five even though three are quoted.
    expect(note).toContain("5 were refused by the mail server");
    expect(note).toContain("second");
    expect(note).toContain("third");
    expect(note).not.toContain("fourth");
    expect(note).not.toContain("fifth");
    // 120 characters of the long one, then the ellipsis -- not 200.
    expect(note).toContain(`${"x".repeat(120)}\u2026`);
    expect(note).not.toContain("x".repeat(121));
  });

  // Not a case any UI can currently produce (the route rejects an empty
  // threadIds array), but the summary must not invent an outcome for it.
  it("summarizes an empty result set as nothing having happened", () => {
    const summary = summarizeBulkResult("archive", []);
    expect(summary).toMatchObject({ moved: 0, skipped: 0, failed: 0, notes: [], settingsLink: false });
    expect(summary.headline).toBe("Nothing archived.");
  });
});

describe("selectionLabel", () => {
  it("counts what is selected, and names the limit when a gesture was cut short", () => {
    expect(selectionLabel(3, null)).toBe("3 selected");
    expect(selectionLabel(50, 120)).toBe("50 of 120 selected (per-request limit)");
  });
});

describe("bulkPendingLabel", () => {
  it("says what is happening, in the action's own words", () => {
    expect(bulkPendingLabel("archive", 3)).toBe("Archiving 3 conversations\u2026");
    expect(bulkPendingLabel("trash", 2)).toBe("Moving 2 conversations to Trash\u2026");
    expect(bulkPendingLabel("hide", 1)).toBe("Hiding 1 conversation\u2026");
  });
});

describe("moveTargetPatch", () => {
  const account = { trashFolder: "Trash", archiveFolder: null };

  it("sends nothing at all when neither field was touched", () => {
    expect(moveTargetPatch(null, null, account)).toEqual({});
  });

  /**
   * The round trip this function exists for, in one test.
   *
   * The form is opened on an account with no Archive target, the user types one
   * and saves -- and BETWEEN those two moments a discovery pass fills in the
   * Trash target from the server's SPECIAL-USE attributes. The save must not
   * carry an opinion about Trash: the old shape seeded both fields at mount and
   * sent both, so it sent `trashFolder: null` and wiped what discovery had just
   * detected.
   */
  it("leaves an untouched field alone even after the account gained a value", () => {
    const before = { trashFolder: null, archiveFolder: null };
    // Opened against `before`; only Archive is typed into.
    const patch = moveTargetPatch(null, "Archive", before);
    expect(patch).toEqual({ archiveFolder: "Archive" });
    expect("trashFolder" in patch).toBe(false);
    // The same edit, saved after a pass detected a Trash folder: still silent
    // about Trash.
    const patchAfterDiscovery = moveTargetPatch(null, "Archive", { trashFolder: "Trash", archiveFolder: null });
    expect(patchAfterDiscovery).toEqual({ archiveFolder: "Archive" });
  });

  it("sends null for a field cleared on purpose -- the detect-for-me state", () => {
    expect(moveTargetPatch("", null, account)).toEqual({ trashFolder: null });
    expect(moveTargetPatch("   ", null, account)).toEqual({ trashFolder: null });
  });

  it("trims what it sends, and drops an edit that changed nothing", () => {
    expect(moveTargetPatch("  Bin  ", null, account)).toEqual({ trashFolder: "Bin" });
    // Typed and retyped the same value: not an edit.
    expect(moveTargetPatch("Trash", null, account)).toEqual({});
    expect(moveTargetPatch(" Trash ", null, account)).toEqual({});
    // Clearing a field that is already null is not an edit either.
    expect(moveTargetPatch(null, "", account)).toEqual({});
  });

  it("sends both when both were edited", () => {
    expect(moveTargetPatch("Bin", "Filed", account))
      .toEqual({ trashFolder: "Bin", archiveFolder: "Filed" });
  });
});

describe("bulkErrorMessage", () => {
  // The API route documents that a 504 means the ANSWER was lost, not the
  // action -- the queued moves carry on regardless -- so the copy must not
  // claim a failure and the caller refetches.
  it("treats a gateway timeout as an unknown outcome, not a failure", () => {
    for (const status of [408, 502, 504]) {
      expect(bulkErrorMessage(new ApiError("Gateway Time-out", status, "unknown"))).toBe(BULK_TIMEOUT_MESSAGE);
    }
  });

  it("treats a network-level failure the same way", () => {
    expect(bulkErrorMessage(new TypeError("Failed to fetch"))).toBe(BULK_TIMEOUT_MESSAGE);
  });

  it("shows a real API refusal as itself", () => {
    expect(bulkErrorMessage(new ApiError("trash accepts at most 50 threads per request", 400, "validation")))
      .toBe("trash accepts at most 50 threads per request");
  });

  // A parse failure happens AFTER a 200: the request arrived, the action ran,
  // and only this client's reading of the answer failed. Telling the user it
  // timed out would be false twice over -- about the request, and about
  // whether the changes applied.
  it("does not call a response-shape failure a timeout", () => {
    const error = new ResponseShapeError("Unexpected response shape from the server (bulk thread action result)");
    expect(bulkErrorMessage(error)).toBe(error.message);
    expect(bulkErrorMessage(error)).not.toBe(BULK_TIMEOUT_MESSAGE);
  });
});

describe("messageIsInTrash", () => {
  const trashByAccount = new Map<string, string | null>([["a1", "Trash"], ["a2", null]]);

  it("is true only for a message sitting in its own account's trash folder", () => {
    expect(messageIsInTrash({ accountId: "a1", folder: "Trash" }, trashByAccount)).toBe(true);
    expect(messageIsInTrash({ accountId: "a1", folder: "INBOX" }, trashByAccount)).toBe(false);
    // Byte-exact: IMAP mailbox names are compared as bytes everywhere else here.
    expect(messageIsInTrash({ accountId: "a1", folder: "trash" }, trashByAccount)).toBe(false);
  });

  it("is false when the account has no resolved trash folder, or is not ours to know", () => {
    expect(messageIsInTrash({ accountId: "a2", folder: "Trash" }, trashByAccount)).toBe(false);
    expect(messageIsInTrash({ accountId: "a9", folder: "Trash" }, trashByAccount)).toBe(false);
  });
});
