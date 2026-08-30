import { inflateSync } from "node:zlib";

/**
 * READING A PDF IN A TEST, WITHOUT ASSERTING ONE VERSION'S REPRESENTATION.
 *
 * WeasyPrint 61.1 (the Ubuntu 24.04 CI runner) compresses object streams by default;
 * 57.2 (the Debian 12 server) does not. So a name, a URI or a page tree is plain text
 * on one machine and invisible on the other, and a raw byte search over the file
 * passes here and fails there -- or worse, passes here and passes there VACUOUSLY,
 * when the assertion is a negative one.
 *
 * That trap has now cost three CI rounds in three different tasks: Task 1 on
 * `/EmbeddedFiles`, Task 2 on the page tree, and Task 3 on a `/URI` string. This
 * module exists so the fourth one does not have to be a fourth copy of the same loop.
 *
 * The reader itself is pinned by documents-seed.test.ts against a hand-built PDF
 * whose page tree exists ONLY inside a compressed object stream -- no renderer of any
 * version involved, which is the only way to prove it against the machine you are not
 * sitting at.
 */

/** The PDF's bytes plus every Flate stream in it, inflated, as one searchable string. */
export function pdfText(pdf: Buffer): string {
  const parts = [pdf.toString("latin1")];
  let from = 0;
  for (;;) {
    const start = pdf.indexOf("stream", from);
    if (start === -1) break;
    const end = pdf.indexOf("endstream", start);
    if (end === -1) break;
    let body = start + "stream".length;
    if (pdf[body] === 0x0d) body += 1;
    if (pdf[body] === 0x0a) body += 1;
    try {
      parts.push(inflateSync(pdf.subarray(body, end)).toString("latin1"));
    } catch {
      // Not a Flate stream, or not a stream at all. Keep looking.
    }
    // Past the whole "endstream" keyword, not one byte into it: resuming at end + 1
    // makes the next search match the "stream" inside it, whose paired "endstream" is
    // the FOLLOWING object's -- which silently skips every other stream in the file.
    from = end + "endstream".length;
  }
  return parts.join("\n");
}

/** Pages, from the page tree's own count rather than by counting page objects. */
export function pageCount(pdf: Buffer): number {
  const counts = (pdfText(pdf).match(/\/Count\s+(\d+)/g) ?? []).map((m) => Number(/\d+/.exec(m)![0]));
  // An intermediate node carries its own subtree's count, so the root's is the
  // largest -- true whatever shape the producer gives the tree.
  return counts.length === 0 ? 0 : Math.max(...counts);
}

/** An image XObject: what a `data:` logo becomes, and what an absent one does not. */
export function pdfHasImage(pdf: Buffer): boolean {
  return /\/Subtype\s*\/Image/.test(pdfText(pdf));
}

/**
 * WHAT THE PAGE SAYS, WHICH IS NOT WHAT `pdfText` FINDS.
 *
 * A word printed on a quote is NOT in the file as that word. WeasyPrint embeds a
 * subset of DejaVu and writes text as glyph ids, so "Mevr Wilhelmina Zeldenrust"
 * on the page is `[<0030004800590055...>] TJ` in the content stream and a search
 * for any of it -- raw or inflated -- returns false. Measured: on a real quote,
 * `pdfText` found neither the salutation, nor the contact, nor the company name,
 * while every one of them was visibly on the page.
 *
 * That is a trap of exactly the shape this module's header describes, and the
 * dangerous half is the NEGATIVE assertion: "the new salutation is not in the
 * PDF" passes vacuously against `pdfText` whether it is there or not.
 *
 * THE GLYPH IDS ARE TRANSLATABLE, because the file carries the table. Every
 * subset font has a `/ToUnicode` CMap mapping its ids back to characters -- it is
 * what makes a PDF's text selectable -- and `pdfText` above has already put those
 * CMaps within reach, plain on 57.2 and inflated out of an object stream on 61.1.
 *
 * EVERY CMAP IS APPLIED TO EVERY RUN, and the alternative was a parser. Doing it
 * properly means resolving each page's `/Font` resources to their font objects and
 * their `/ToUnicode` streams by object number, and tracking the `Tf` in force
 * across the content stream: a small PDF reader, in a test helper. Decoding the
 * whole stream once per CMap instead is a few lines, and it is SOUND FOR BOTH
 * DIRECTIONS OF THE ASSERTION:
 *
 *   - a run in the font whose CMap is being applied decodes CORRECTLY, so
 *     anything really on the page appears in the output;
 *   - a run in a different font decodes to a SUBSEQUENCE of its true text with
 *     the unmapped ids dropped (the bold subset over the body text produces
 *     "Mer ilelmia elderust"), because a wrong map cannot INVENT characters --
 *     an id absent from it contributes nothing rather than something else.
 *
 * So a false positive would need the needle to be spelled by dropping letters out
 * of text that is genuinely on the page, which a distinctive multi-word needle
 * cannot be, and a false negative cannot happen at all. Assert on something more
 * specific than a two-letter word and the ambiguity never arises.
 *
 * LINES ARE JOINED WITH A NEWLINE AND NEVER RUN TOGETHER, so a needle can never
 * be assembled out of two unrelated lines that happen to abut. A run is one
 * text-showing operator, which is how WeasyPrint emits a line: the kerning numbers
 * inside a `TJ` array split one line into several hex strings, and those ARE
 * concatenated, since they are one line by construction.
 *
 * THE ONE SHAPE IT DOES NOT READ is a literal `(...)` string, which a font with a
 * simple encoding would produce. Neither renderer in this project writes one --
 * both subset -- and if one ever did, `pdfText`'s raw half would find the text
 * directly. The `itReal` assertion in documents-seed.test.ts is what would notice:
 * it renders a real quote and requires a real line back, so a version that changed
 * its encoding fails there rather than turning every caller vacuous.
 */
export function pdfVisibleText(pdf: Buffer): string {
  const text = pdfText(pdf);
  const runs = textRuns(text);
  return toUnicodeMaps(text).map((map) => runs.map((run) => decodeRun(run, map)).join("\n")).join("\n");
}

/**
 * Every `<hex>` string of every text-showing operator, one entry per operator.
 *
 * THE ARRAY'S BODY IS MATCHED WITH A NEGATED CLASS RATHER THAN WITH THE
 * ALTERNATION IT REALLY IS, and that is a performance decision bought expensively.
 * The faithful pattern -- hex strings and kerning numbers alternating under a `*`
 * -- backtracks catastrophically over the megabytes of inflated font and image
 * data `pdfText` hands over. MEASURED: one 475KB quote with a logo in it took
 * 2.7 MINUTES to read that way and reads in milliseconds this way, and three e2e
 * journeys each paid it. `[^\]]` cannot backtrack, and the bound stops a stray `[`
 * in binary data swallowing the rest of the file looking for a `] TJ`. Whatever
 * the looser match lets through is filtered by the hex extraction inside it.
 */
function textRuns(text: string): string[] {
  const runs: string[] = [];
  // A TJ array: hex strings separated by kerning numbers, all one line. The `?? ""`
  // on every capture is `noUncheckedIndexedAccess`: a group that matched cannot be
  // undefined, and the compiler has no way to know that.
  for (const [, body] of text.matchAll(/\[([^\]]{0,4096})\]\s*TJ/g)) {
    runs.push([...(body ?? "").matchAll(/<([0-9a-fA-F]*)>/g)].map(([, hex]) => hex ?? "").join(""));
  }
  for (const [, hex] of text.matchAll(/<([0-9a-fA-F]{0,4096})>\s*Tj/g)) runs.push(hex ?? "");
  return runs;
}

/** Two-byte codes through one CMap; an id the map does not carry contributes nothing. */
function decodeRun(run: string, map: ReadonlyMap<string, string>): string {
  let out = "";
  for (let i = 0; i + 4 <= run.length; i += 4) out += map.get(run.slice(i, i + 4).toLowerCase()) ?? "";
  return out;
}

/**
 * Every `/ToUnicode` CMap in the file, as glyph id -> characters.
 *
 * Both of the CMap's own forms are read. `bfchar` lists pairs and is what 57.2
 * emits; `bfrange` gives a start, an end and the first destination, and is the
 * compact form a producer uses for a contiguous run -- absent from the output
 * measured here, and cheap enough to support rather than discover missing on the
 * runner. A range is bounded so a malformed `<0000> <ffff>` cannot spin.
 */
function toUnicodeMaps(text: string): ReadonlyMap<string, string>[] {
  const maps: ReadonlyMap<string, string>[] = [];
  for (const block of text.match(/begincmap[\s\S]*?endcmap/g) ?? []) {
    const map = new Map<string, string>();
    for (const chunk of block.match(/beginbfchar[\s\S]*?endbfchar/g) ?? []) {
      for (const [, code, value] of chunk.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        map.set((code ?? "").toLowerCase().padStart(4, "0"), utf16(value ?? ""));
      }
    }
    for (const chunk of block.match(/beginbfrange[\s\S]*?endbfrange/g) ?? []) {
      for (const [, lo, hi, value] of chunk.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        const first = Number.parseInt(lo ?? "", 16);
        const last = Math.min(Number.parseInt(hi ?? "", 16), first + 65_535);
        const base = Number.parseInt(value ?? "", 16);
        for (let code = first; code <= last; code += 1) {
          map.set(code.toString(16).padStart(4, "0"), String.fromCodePoint(base + (code - first)));
        }
      }
    }
    if (map.size > 0) maps.push(map);
  }
  return maps;
}

/** A CMap destination: UTF-16BE, so one code point can be four hex digits or eight. */
function utf16(hex: string): string {
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
  return out;
}
