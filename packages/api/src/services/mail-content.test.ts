import { describe, it, expect } from "vitest";
import { simpleParser } from "mailparser";
import {
  sanitizeMailHtml,
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

  it("rewrites a mapped cid image to the authenticated attachment route", () => {
    const out = sanitizeMailHtml('<img src="cid:logo123@mail" alt="logo">', {
      cidMap: { "logo123@mail": "attach-1" },
    });
    expect(out).toContain('src="/api/mail/attachments/attach-1/inline"');
    expect(out).not.toContain("cid:");
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

  it("keeps an inline style attribute on allowed tags", () => {
    const out = sanitizeMailHtml('<p style="color:red;font-weight:bold">hi</p>');
    expect(out).toContain('style="color:red;font-weight:bold"');
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

  it("returns (no subject) for an empty string", () => {
    expect(normalizeSubject("")).toBe("(no subject)");
  });

  it("returns (no subject) when only a prefix chain remains", () => {
    expect(normalizeSubject("Re: Fwd:")).toBe("(no subject)");
  });

  it("returns (no subject) for whitespace-only input", () => {
    expect(normalizeSubject("   ")).toBe("(no subject)");
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

  it("strips inline tags without adding a line break", () => {
    expect(htmlToText("<b>Bold</b> and <i>italic</i>")).toBe("Bold and italic");
  });

  it("collapses whitespace within a line", () => {
    expect(htmlToText("<p>Hello    world</p>")).toBe("Hello world");
  });

  it("collapses a run of 3+ blank lines down to one blank line", () => {
    expect(htmlToText("<p>A</p><br><br><br><p>B</p>")).toBe("A\n\nB");
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

  it("only hashes the first 1000 characters of the body text", () => {
    const longA = { ...base, text: "x".repeat(1000) + "AAAA" };
    const longB = { ...base, text: "x".repeat(1000) + "BBBB" };
    expect(syntheticMessageId(longA)).toBe(syntheticMessageId(longB));
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
});
