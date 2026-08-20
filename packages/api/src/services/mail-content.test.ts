import { describe, it, expect } from "vitest";
import { simpleParser } from "mailparser";
import {
  sanitizeMailHtml,
  resolveAttachmentUrls,
  normalizeSubject,
  makeSnippet,
  syntheticMessageId,
  extractAddresses,
  htmlToText,
} from "./mail-content.js";

describe("sanitizeMailHtml", () => {
  it("keeps allowed structural and inline text tags", () => {
    const html = "<div><p>Hello <strong>world</strong>, <em>this</em> is <span>fine</span>.</p></div>";
    expect(sanitizeMailHtml(html)).toBe(html);
  });

  it("keeps the table family with its structure intact", () => {
    const html = "<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Alice</td></tr></tbody></table>";
    expect(sanitizeMailHtml(html)).toBe(html);
  });

  it("strips script tags and discards their text content", () => {
    const out = sanitizeMailHtml("<p>before</p><script>alert(1)</script><p>after</p>");
    expect(out).toBe("<p>before</p><p>after</p>");
    expect(out).not.toContain("alert");
  });

  it("strips style tags and discards their text content", () => {
    const out = sanitizeMailHtml("<style>body{color:red}</style><p>Hi</p>");
    expect(out).toBe("<p>Hi</p>");
    expect(out).not.toContain("color:red");
  });

  it("strips iframe tags", () => {
    const out = sanitizeMailHtml('<p>Hi</p><iframe src="https://evil.example/"></iframe>');
    expect(out).toBe("<p>Hi</p>");
    expect(out).not.toContain("iframe");
  });

  it("strips object tags", () => {
    const out = sanitizeMailHtml('<object data="https://evil.example/x.swf"></object><p>Hi</p>');
    expect(out).not.toContain("object");
    expect(out).toBe("<p>Hi</p>");
  });

  it("strips embed tags", () => {
    const out = sanitizeMailHtml('<embed src="https://evil.example/x.swf"><p>Hi</p>');
    expect(out).not.toContain("embed");
    expect(out).toBe("<p>Hi</p>");
  });

  it("strips form and input tags but keeps surrounding content", () => {
    const out = sanitizeMailHtml('<form action="/x"><input type="text" name="y"><p>Inside</p></form><p>Outside</p>');
    expect(out).not.toContain("<form");
    expect(out).not.toContain("<input");
    expect(out).toContain("<p>Inside</p>");
    expect(out).toContain("<p>Outside</p>");
  });

  it("strips on* attributes from otherwise-allowed tags", () => {
    const out = sanitizeMailHtml('<p onclick="alert(1)" onmouseover="evil()">hi</p>');
    expect(out).toBe("<p>hi</p>");
  });

  it("strips on* attributes from img tags", () => {
    const out = sanitizeMailHtml('<img src="https://example.com/a.png" onerror="evil()" alt="a">');
    expect(out).not.toContain("onerror");
  });

  it("forces rel=noopener noreferrer and target=_blank on a tags with no existing rel/target", () => {
    const out = sanitizeMailHtml('<a href="https://example.com/">link</a>');
    expect(out).toContain('href="https://example.com/"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it("overwrites an existing rel/target on a tags rather than merging with it", () => {
    const out = sanitizeMailHtml('<a href="https://example.com/" rel="nofollow" target="_self">link</a>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
    expect(out).not.toContain("nofollow");
    expect(out).not.toContain('target="_self"');
  });

  it("strips a javascript: href entirely rather than letting it through", () => {
    const out = sanitizeMailHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
  });

  it("keeps an http image src as-is", () => {
    const out = sanitizeMailHtml('<img src="http://example.com/a.png" alt="a">');
    expect(out).toContain('src="http://example.com/a.png"');
  });

  it("keeps an https image src as-is", () => {
    const out = sanitizeMailHtml('<img src="https://example.com/a.png" alt="a">');
    expect(out).toContain('src="https://example.com/a.png"');
  });

  it("keeps a relative img src as-is (scheme-less srcs bypass allowedSchemesByTag by design of sanitize-html)", () => {
    const out = sanitizeMailHtml('<img src="/static/logo.png" alt="logo">');
    expect(out).toContain('src="/static/logo.png"');
  });

  it("keeps a protocol-relative img src as-is (same bypass -- treated as remote-equivalent)", () => {
    const out = sanitizeMailHtml('<img src="//example.com/x.png" alt="x">');
    expect(out).toContain('src="//example.com/x.png"');
  });

  it("rewrites a mapped cid image to the stable placeholder scheme, never an absolute route", () => {
    const out = sanitizeMailHtml('<img src="cid:logo123@mail" alt="logo">', {
      cidMap: { "logo123@mail": "attach-1" },
    });
    expect(out).toContain('src="mailattachment:attach-1"');
    expect(out).not.toContain("cid:");
    expect(out).not.toContain("/api/mail/attachments/");
  });

  it("strips surrounding <> from a cid src before the cidMap lookup", () => {
    const out = sanitizeMailHtml('<img src="cid:<logo@x>" alt="logo">', { cidMap: { "logo@x": "attach-9" } });
    expect(out).toContain('src="mailattachment:attach-9"');
  });

  it("percent-decodes a cid src before the cidMap lookup", () => {
    const out = sanitizeMailHtml('<img src="cid:logo%40x" alt="logo">', { cidMap: { "logo@x": "attach-9" } });
    expect(out).toContain('src="mailattachment:attach-9"');
  });

  it("drops an img tag whose cid has no entry in cidMap", () => {
    const out = sanitizeMailHtml('<p>before</p><img src="cid:unknown@mail" alt="x"><p>after</p>', {
      cidMap: { "logo123@mail": "attach-1" },
    });
    expect(out).toBe("<p>before</p><p>after</p>");
  });

  it("drops an img tag with a cid src when no cidMap is given at all", () => {
    const out = sanitizeMailHtml('<img src="cid:logo123@mail" alt="logo">');
    expect(out).toBe("");
  });

  it("drops an img tag with a data: src", () => {
    const out = sanitizeMailHtml('<img src="data:image/png;base64,AAAA" alt="x">');
    expect(out).toBe("");
  });

  it("drops an img tag with a javascript: src", () => {
    const out = sanitizeMailHtml('<img src="javascript:alert(1)" alt="x">');
    expect(out).toBe("");
    expect(out).not.toContain("javascript:");
  });

  it("drops an inbound img that already carries the mailattachment: scheme", () => {
    // Only the cid -> cidMap rewrite may emit this scheme. A message
    // arriving with it in an img src is naming an attachment id it has no
    // relationship to (any thread, any user), which serve-time resolution
    // would happily turn into a real URL.
    const out = sanitizeMailHtml('<p>a</p><img src="mailattachment:11111111-1111-1111-1111-111111111111" alt="x">');
    expect(out).toBe("<p>a</p>");
  });

  it("drops an inbound mailattachment: img whatever its casing or leading space", () => {
    const out = sanitizeMailHtml('<img src="  MailAttachment:11111111-1111-1111-1111-111111111111">', {
      cidMap: { "logo@x": "attach-1" },
    });
    expect(out).toBe("");
  });

  it("keeps an inline style attribute (multiple safe properties) on allowed tags", () => {
    const out = sanitizeMailHtml('<p style="color:red;font-weight:bold">hi</p>');
    expect(out).toContain('style="color:red;font-weight:bold"');
  });

  it("keeps a safe color style value", () => {
    const out = sanitizeMailHtml('<p style="color:red">hi</p>');
    expect(out).toContain('style="color:red"');
  });

  it("strips a background:url(...) declaration (property not allowed at all)", () => {
    const out = sanitizeMailHtml('<p style="background:url(https://evil.example/beacon.png)">hi</p>');
    expect(out).not.toContain("url(");
    expect(out).not.toContain("background");
    expect(out).toBe("<p>hi</p>");
  });

  it("strips a position:fixed declaration (property not allowed at all)", () => {
    const out = sanitizeMailHtml('<p style="position:fixed;top:0;left:0">hi</p>');
    expect(out).not.toContain("position");
    expect(out).not.toContain("fixed");
    expect(out).toBe("<p>hi</p>");
  });

  it("keeps colspan on td -- structural, not just cosmetic", () => {
    const out = sanitizeMailHtml('<table><tr><td colspan="2">x</td></tr></table>');
    expect(out).toContain('colspan="2"');
  });

  it("keeps rowspan, align, and bgcolor on table-family tags", () => {
    const out = sanitizeMailHtml('<table bgcolor="#eee"><tr><td rowspan="2" align="center">x</td></tr></table>');
    expect(out).toContain('bgcolor="#eee"');
    expect(out).toContain('rowspan="2"');
    expect(out).toContain('align="center"');
  });

  it("keeps the legacy font tag and its color attribute", () => {
    const out = sanitizeMailHtml('<font color="red">hi</font>');
    expect(out).toBe('<font color="red">hi</font>');
  });

  it("strips a disallowed tag but keeps its allowed children/text", () => {
    const out = sanitizeMailHtml("<marquee><p>still here</p></marquee>");
    expect(out).not.toContain("marquee");
    expect(out).toContain("<p>still here</p>");
  });

  it("leaves remote (http/https) images untouched in the markup -- blocking is render-time, not ingest-time", () => {
    const out = sanitizeMailHtml('<img src="https://tracker.example.com/pixel.gif" alt="">');
    expect(out).toContain("https://tracker.example.com/pixel.gif");
  });
});

describe("resolveAttachmentUrls", () => {
  it("swaps a stored placeholder for the authenticated route under a root basePath", () => {
    const stored = '<img src="mailattachment:attach-1" alt="logo">';
    expect(resolveAttachmentUrls(stored, "/")).toBe('<img src="/api/mail/attachments/attach-1/inline" alt="logo">');
  });

  it("prefixes the route with a non-root basePath", () => {
    const stored = '<img src="mailattachment:attach-1" alt="logo">';
    expect(resolveAttachmentUrls(stored, "/conduit")).toBe(
      '<img src="/conduit/api/mail/attachments/attach-1/inline" alt="logo">',
    );
  });

  it("resolves every placeholder occurrence, not just the first", () => {
    const stored = '<img src="mailattachment:a1"><img src="mailattachment:a2">';
    expect(resolveAttachmentUrls(stored, "/")).toBe(
      '<img src="/api/mail/attachments/a1/inline"><img src="/api/mail/attachments/a2/inline">',
    );
  });
});

describe("normalizeSubject", () => {
  it("strips a single Re: prefix", () => {
    expect(normalizeSubject("Re: Hello")).toBe("Hello");
  });

  it("strips a chain of mixed-case Re:/Fwd: prefixes", () => {
    expect(normalizeSubject("RE: Fwd: re: Hello")).toBe("Hello");
  });

  it("strips a bracketed reply count like Re[2]:", () => {
    expect(normalizeSubject("Re[2]: Hello")).toBe("Hello");
  });

  it("strips Fw: (three-letter variant) too", () => {
    expect(normalizeSubject("Fw: Hello")).toBe("Hello");
  });

  it("strips a prefix with no space after the colon", () => {
    expect(normalizeSubject("Fwd:Hello")).toBe("Hello");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeSubject("Hello    World")).toBe("Hello World");
  });

  it("trims and collapses surrounding whitespace with no prefix present", () => {
    expect(normalizeSubject("  Hello   World  ")).toBe("Hello World");
  });

  it("returns an empty string for an empty input -- matches the DB default, not a display placeholder", () => {
    expect(normalizeSubject("")).toBe("");
  });

  it("returns an empty string when only a prefix chain remains", () => {
    expect(normalizeSubject("Re: Fwd:")).toBe("");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeSubject("   ")).toBe("");
  });

  it("normalizes a pathological subject (word + 60k trailing spaces, no colon) in well under 50ms", () => {
    const pathological = `Re${" ".repeat(60000)}`;
    const start = Date.now();
    const result = normalizeSubject(pathological);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(typeof result).toBe("string");
  });
});

describe("makeSnippet", () => {
  it("collapses whitespace runs including newlines into single spaces", () => {
    expect(makeSnippet("Hello\n\n  world\tfoo")).toBe("Hello world foo");
  });

  it("trims leading and trailing whitespace", () => {
    expect(makeSnippet("   padded text   ")).toBe("padded text");
  });

  it("truncates to the first 160 characters", () => {
    const long = "a".repeat(200);
    const snippet = makeSnippet(long);
    expect(snippet).toHaveLength(160);
    expect(snippet).toBe("a".repeat(160));
  });

  it("returns the whole string unchanged in length when under 160 chars", () => {
    expect(makeSnippet("short")).toBe("short");
  });

  it("slices on Unicode code points, not UTF-16 units, keeping an emoji at the boundary intact", () => {
    // Built via fromCodePoint (not a literal or a \u escape) to keep this
    // source file pure ASCII: U+1F600 GRINNING FACE, a surrogate pair in
    // UTF-16 -- exactly the case where naive .slice(0, 160) could split it.
    const emoji = String.fromCodePoint(0x1f600);
    const text = "a".repeat(159) + emoji + " more text beyond the boundary";
    const snippet = makeSnippet(text);
    expect(Array.from(snippet)).toHaveLength(160);
    expect(snippet.endsWith(emoji)).toBe(true);
  });
});

describe("htmlToText", () => {
  it("converts block-level closing tags into newlines and strips the rest", () => {
    expect(htmlToText("<p>Hello</p><p>World</p>")).toBe("Hello\nWorld");
  });

  it("converts br into a newline", () => {
    expect(htmlToText("Line1<br>Line2<br/>Line3")).toBe("Line1\nLine2\nLine3");
  });

  it("decodes common entities, decoding &amp; last so it cannot double-unescape", () => {
    expect(htmlToText("Tom &amp; Jerry &lt;3&gt; &quot;fun&quot; &#39;times&#39;")).toBe(
      "Tom & Jerry <3> \"fun\" 'times'",
    );
  });

  it("decodes numeric entities, both decimal and hex", () => {
    // Expected characters built via fromCharCode (not literals) to keep
    // this source file pure ASCII: U+00E9 (e acute, decimal 233) and
    // U+2019 (right single quotation mark, hex 2019).
    const eAcute = String.fromCharCode(0xe9);
    const rightSingleQuote = String.fromCharCode(0x2019);
    expect(htmlToText("Caf&#233; &#x2019;quote&#x2019;")).toBe(
      `Caf${eAcute} ${rightSingleQuote}quote${rightSingleQuote}`,
    );
  });

  it("keeps a link's destination as text after stripping the tag", () => {
    expect(htmlToText('<a href="https://example.com/">Click here</a>')).toBe("Click here <https://example.com/>");
  });

  it("separates table cells with a space rather than running them together", () => {
    expect(htmlToText("<tr><td>A</td><td>B</td></tr>")).toBe("A B");
  });

  it("strips inline tags without adding a line break", () => {
    expect(htmlToText("<b>Bold</b> and <i>italic</i>")).toBe("Bold and italic");
  });

  it("collapses whitespace within a line", () => {
    expect(htmlToText("<p>Hello    world</p>")).toBe("Hello world");
  });

  it("collapses a run of 3+ blank lines down to one blank line", () => {
    expect(htmlToText("<p>A</p><br><br><br><p>B</p>")).toBe("A\n\nB");
  });

  it("strips C0 controls from the input so the link markers cannot be forged", () => {
    // SOH/STX are what the function itself uses to hold a link's destination
    // across the tag strip. Arriving in the INPUT they would survive to the
    // final restore step and turn into angle brackets, letting a crafted
    // body fabricate a "<https://evil.example/>" destination on a link that
    // has none -- or wrap arbitrary text so it reads as one.
    const soh = String.fromCharCode(1);
    const stx = String.fromCharCode(2);
    expect(htmlToText(`Totally safe ${soh}https://evil.example/${stx}`)).toBe("Totally safe https://evil.example/");
    // Every other C0 control goes too (tab, newline and carriage return are
    // the deliberate exceptions -- they are ordinary whitespace here).
    expect(htmlToText(`a${String.fromCharCode(0)}b${String.fromCharCode(0x1f)}c`)).toBe("abc");
    expect(htmlToText("a\tb\nc")).toBe("a b\nc");
    // ...and the numeric-entity spelling of the same thing, which decodes
    // after the input strip has already run.
    expect(htmlToText("Totally safe &#1;https://evil.example/&#2;")).toBe("Totally safe https://evil.example/");
    expect(htmlToText("Totally safe &#x1;https://evil.example/&#x2;")).toBe("Totally safe https://evil.example/");
  });

  it("caps its input by BYTES, without splitting a character at the boundary", () => {
    // U+4E2D is three bytes, so filling the budget to one byte short of the
    // cap leaves it straddling the boundary. A code-unit slice would cut it
    // in half; capUtf8 holds the partial sequence back instead, so nothing
    // decodes to U+FFFD.
    const wide = String.fromCharCode(0x4e2d);
    const text = htmlToText("a".repeat(256 * 1024 - 1) + wide + "trailing");
    expect(text).not.toContain(String.fromCharCode(0xfffd));
    expect(text).not.toContain(wide);
    expect(text).not.toContain("trailing");
    expect(text.endsWith("a")).toBe(true);
  });

  it("caps its input length", () => {
    // A_TAG_RE is quadratic against unclosed <a> tags (the lazy inner group
    // rescans to the end of the string from every one of them). Unreachable
    // through the documented sanitize-first ordering -- sanitize-html
    // re-serialises balanced markup -- so this is a bound, not a fix.
    const oversized = "<p>x</p>".repeat(100_000);
    expect(oversized.length).toBeGreaterThan(256 * 1024);
    const text = htmlToText(oversized);
    // One "x" plus one newline per repetition, and the cap lands inside the
    // input rather than at the end of it.
    expect(text.length).toBeLessThan(oversized.length / 2);
    expect(text.startsWith("x\nx\n")).toBe(true);
  });
});

describe("syntheticMessageId", () => {
  const base = {
    from: { value: [{ address: "alice@example.com", name: "Alice" }], html: "", text: "" },
    date: new Date("2026-08-19T10:00:00.000Z"),
    subject: "Hello",
    text: "Hi there, this is the body.",
  };

  it("produces a sha256: prefixed 64-character hex digest", () => {
    const id = syntheticMessageId(base);
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic for identical input", () => {
    expect(syntheticMessageId(base)).toBe(syntheticMessageId(base));
  });

  it("is stable across two structurally-equal-but-distinct parsed objects (refetch)", () => {
    const refetched = {
      from: { value: [{ address: "alice@example.com", name: "Alice" }], html: "", text: "" },
      date: new Date("2026-08-19T10:00:00.000Z"),
      subject: "Hello",
      text: "Hi there, this is the body.",
    };
    expect(syntheticMessageId(base)).toBe(syntheticMessageId(refetched));
  });

  it("changes when the subject differs", () => {
    expect(syntheticMessageId(base)).not.toBe(syntheticMessageId({ ...base, subject: "Different" }));
  });

  it("changes when the from address differs", () => {
    const other = { ...base, from: { value: [{ address: "bob@example.com", name: "Bob" }], html: "", text: "" } };
    expect(syntheticMessageId(base)).not.toBe(syntheticMessageId(other));
  });

  it("changes when the sent_at differs", () => {
    expect(syntheticMessageId(base)).not.toBe(
      syntheticMessageId({ ...base, date: new Date("2026-08-19T10:00:01.000Z") }),
    );
  });

  it("hashes the raw Date header text, not mailparser's parsed Date object", () => {
    // The defect this closes: for a present-but-unparseable Date header
    // ("Date: not a date") mailparser synthesises `date = new Date()` --
    // the moment of parsing -- so hashing that object gave a different id
    // on every parse, and one message became a new row and a new thread on
    // every single refetch. Same raw header line + different synthesised
    // Date objects must hash identically.
    const headerLines = [{ key: "date", line: "Date: not a date" }];
    const firstParse = { ...base, date: new Date("2026-08-19T10:00:00.000Z"), headerLines };
    const secondParse = { ...base, date: new Date("2026-08-19T10:00:07.000Z"), headerLines };
    expect(syntheticMessageId(firstParse)).toBe(syntheticMessageId(secondParse));
  });

  it("still distinguishes two messages whose raw Date headers differ", () => {
    const monday = { ...base, headerLines: [{ key: "date", line: "Date: Mon, 17 Aug 2026 10:00:00 +0000" }] };
    const tuesday = { ...base, headerLines: [{ key: "date", line: "Date: Tue, 18 Aug 2026 10:00:00 +0000" }] };
    expect(syntheticMessageId(monday)).not.toBe(syntheticMessageId(tuesday));
  });

  it("falls back to the parsed date when there is no Date header line at all", () => {
    const noDateHeader = { ...base, headerLines: [{ key: "subject", line: "Subject: Hello" }] };
    expect(syntheticMessageId(noDateHeader)).toBe(syntheticMessageId(base));
  });

  it("only hashes the first 1000 characters of the body text", () => {
    const longA = { ...base, text: "x".repeat(1000) + "AAAA" };
    const longB = { ...base, text: "x".repeat(1000) + "BBBB" };
    expect(syntheticMessageId(longA)).toBe(syntheticMessageId(longB));
  });

  it("changes when the message differs only by its attachments", () => {
    // Same sender, date, subject and body, different file: without the
    // attachment fingerprint these collapse to one synthetic id and the
    // second message is silently swallowed by ingest's duplicate guard.
    const invoice = { ...base, attachments: [{ filename: "invoice.pdf", size: 1024 }] };
    const corrected = { ...base, attachments: [{ filename: "invoice-corrected.pdf", size: 1024 }] };
    expect(syntheticMessageId(invoice)).not.toBe(syntheticMessageId(corrected));
    expect(syntheticMessageId(invoice)).not.toBe(syntheticMessageId(base));
  });

  it("changes when an attachment's size differs but its name does not", () => {
    const small = { ...base, attachments: [{ filename: "report.pdf", size: 1024 }] };
    const large = { ...base, attachments: [{ filename: "report.pdf", size: 2048 }] };
    expect(syntheticMessageId(small)).not.toBe(syntheticMessageId(large));
  });

  it("is stable across a refetch of the same attachments", () => {
    const attachments = [{ filename: "a.pdf", size: 10 }, { filename: "b.png", size: 20 }];
    const first = { ...base, attachments };
    const refetched = { ...base, attachments: [{ filename: "a.pdf", size: 10 }, { filename: "b.png", size: 20 }] };
    expect(syntheticMessageId(first)).toBe(syntheticMessageId(refetched));
  });

  it("length-prefixes fields so a separator-shaped substring inside one field cannot forge a boundary collision", () => {
    const a = { ...base, subject: "A::B", text: "C" };
    const b = { ...base, subject: "A", text: "B::C" };
    expect(syntheticMessageId(a)).not.toBe(syntheticMessageId(b));
  });
});

describe("extractAddresses", () => {
  const raw = [
    "From: Alice <alice@example.com>",
    "To: Bob <bob@example.com>, carol@example.com",
    "Cc: Dave <dave@example.com>",
    "Subject: Hi",
    "Date: Mon, 19 Aug 2026 10:00:00 +0000",
    "",
    "Body text.",
  ].join("\r\n");

  it("extracts from/to/cc with lowercased addresses and preserved display names", async () => {
    const parsed = await simpleParser(raw);
    const result = extractAddresses(parsed);
    expect(result.from).toEqual([{ address: "alice@example.com", name: "Alice" }]);
    expect(result.to).toEqual([
      { address: "bob@example.com", name: "Bob" },
      { address: "carol@example.com", name: null },
    ]);
    expect(result.cc).toEqual([{ address: "dave@example.com", name: "Dave" }]);
  });

  it("returns an empty array for an absent header (bcc)", async () => {
    const parsed = await simpleParser(raw);
    const result = extractAddresses(parsed);
    expect(result.bcc).toEqual([]);
  });

  it("lowercases an uppercase address", async () => {
    const upper = raw.replace("alice@example.com", "ALICE@EXAMPLE.COM");
    const parsed = await simpleParser(upper);
    const result = extractAddresses(parsed);
    expect(result.from).toEqual([{ address: "alice@example.com", name: "Alice" }]);
  });

  it("flattens an RFC 5322 named group (e.g. mailing-list-style Cc) into its member addresses", async () => {
    const grouped = [
      "From: Alice <alice@example.com>",
      "To: Bob <bob@example.com>",
      "Cc: Team: bob@example.com, Carol <carol@example.com>;",
      "Subject: Hi",
      "Date: Mon, 19 Aug 2026 10:00:00 +0000",
      "",
      "Body text.",
    ].join("\r\n");
    const parsed = await simpleParser(grouped);
    const result = extractAddresses(parsed);
    expect(result.cc).toEqual([
      { address: "bob@example.com", name: null },
      { address: "carol@example.com", name: "Carol" },
    ]);
  });

  it("returns [] for an empty group (undisclosed-recipients:;) rather than a phantom entry", async () => {
    const undisclosed = [
      "From: Alice <alice@example.com>",
      "To: undisclosed-recipients:;",
      "Subject: Hi",
      "Date: Mon, 19 Aug 2026 10:00:00 +0000",
      "",
      "Body text.",
    ].join("\r\n");
    const parsed = await simpleParser(undisclosed);
    const result = extractAddresses(parsed);
    expect(result.to).toEqual([]);
  });
});
