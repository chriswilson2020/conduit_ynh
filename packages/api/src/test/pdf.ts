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
 *   - a run in a different font decodes to a SUBSEQUENCE of its true text
 *     wherever the two subsets merely DISAGREE ABOUT NOTHING: an id the map does
 *     not carry contributes nothing, which is what turns the body text into
 *     "Mer ilelmia elderust" under the bold subset;
 *   - BUT AN ID PRESENT IN BOTH WITH DIFFERENT MEANINGS SUBSTITUTES RATHER THAN
 *     DROPS, and that can put a word in the output that is on no line of the
 *     page. "Cannot invent characters" was this comment's first claim and it is
 *     false: built by hand and run through this module, two subsets whose ids
 *     collide produce a word outright.
 *
 * WHY THAT IS UNREACHABLE FROM THIS PROJECT'S OUTPUT, measured on a real quote
 * rather than argued. It carries 2 CMaps of 38 and 49 ids which share 32, and
 * ZERO of those 32 disagree -- because both subsets are DejaVu-Sans, one regular
 * and one bold, and a family gives a character the same id in every weight. Two
 * UNRELATED families in one document would break that, and the only way to get
 * one is an operator editing `font-family` in the quote template, which no test
 * here covers. If that ever becomes a thing this product supports, this function
 * needs the parser rather than a wider comment.
 *
 * LINES ARE JOINED WITH A NEWLINE AND NEVER RUN TOGETHER, so a needle can never
 * be assembled out of two unrelated lines that happen to abut. A run is one
 * text-showing operator, which is how WeasyPrint emits a line: the kerning numbers
 * inside a `TJ` array split one line into several hex strings, and those ARE
 * concatenated, since they are one line by construction.
 *
 * A RUN THIS READER DOES NOT SEE IS SILENTLY MISSING TEXT, and that is the failure
 * to be afraid of rather than a wrong character: a `not.toContain` over output that
 * lost the run is exactly the vacuous pass this module exists to prevent.
 * `textRuns` lists the five shapes it does not read. None of them occurs in either
 * renderer here -- measured on a real quote, 25 of 25 text operators matched, the
 * widest body 110 characters against the 4096 bound, and not one literal-string
 * operator in the file -- but "none today" is the whole of that claim.
 *
 * SO THE REAL DEFENCE IS THE PAIRING, NOT THIS FUNCTION, and callers should keep
 * the shape: every `not.toContain` in this suite sits immediately after a
 * `toContain` on the SAME buffer. A reader that came back empty, or that dropped
 * the very run the assertion is about, fails the positive one first, so the
 * negative one is never reached on a reader that has stopped working. An absence
 * asserted on its own would have nothing holding it up.
 *
 * The `itReal` assertion in documents-seed.test.ts is the other half of that: it
 * renders a real quote and requires a real line back, so a renderer that changed
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
 *
 * FIVE SHAPES THIS DOES NOT READ, listed because a MISSING run is what makes a
 * `not.toContain` pass vacuously, and a caller cannot weigh that risk against a
 * promise of completeness that was never true:
 *
 *   1. a `TJ` array containing a literal `(...)` string with a `]` inside it --
 *      the negated class stops at that `]` and the operator is cut short;
 *   2. a nested array, for the same reason;
 *   3. a body over the 4096-character bound, which is simply not matched;
 *   4. the `'` and `"` show operators, which show a string and move to the next
 *      line, and which nothing here looks for;
 *   5. `(...) Tj`, a literal string with a simple encoding rather than glyph ids.
 *
 * Shapes 1, 2 and 5 are what a producer that does not subset its fonts writes;
 * neither WeasyPrint here does. Measured on a real quote: 25 text operators, all
 * 25 matched, the widest body 110 characters, and zero `) Tj`. The reason none of
 * this is closed is shape 5 specifically -- scanning for literal strings across
 * the megabytes of inflated font and image data `pdfText` hands over would match
 * binary noise and put invented text into the output, which is worse than a gap
 * the caller is told about. See `pdfVisibleText` for the pairing that is the
 * actual protection.
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
 * BOTH SECTIONS, AND BOTH OF `bfrange`'s DESTINATION FORMS. `bfchar` lists pairs
 * and is what 57.2 emits. `bfrange` gives a start and an end, and then EITHER a
 * single destination that increments across the range OR an ARRAY holding one
 * destination per id -- and the array is not an exotic corner, it is what a
 * producer writes for a run of ids whose characters are not consecutive.
 *
 * THE ARRAY FORM HAD TO BE HANDLED RATHER THAN IGNORED, which is the part worth
 * writing down. A pattern looking only for three `<...>` in a row does not FAIL to
 * match `<0070> <0072> [<0058> <0059> <005a>]` -- it matches the wrong three,
 * skipping past the real pair and reading the ARRAY's first three entries as a
 * range. The result is a map assigning characters the file never assigned, to ids
 * it really does carry: the one error class this whole module exists to avoid, and
 * silent. One alternation covers both forms, and matching leftmost-first is what
 * stops an array being re-read as a range.
 *
 * Neither WeasyPrint here emits a `bfrange` at all (measured: zero occurrences in
 * a real quote), so all of this is support for a shape that has not arrived rather
 * than a description of today's output.
 *
 * A range is bounded so a malformed `<0000> <ffff>` cannot spin.
 */
function toUnicodeMaps(text: string): ReadonlyMap<string, string>[] {
  const maps: ReadonlyMap<string, string>[] = [];
  for (const block of text.match(/begincmap[\s\S]*?endcmap/g) ?? []) {
    const map = new Map<string, string>();
    for (const chunk of block.match(/beginbfchar[\s\S]*?endbfchar/g) ?? []) {
      for (const [, code, value] of chunk.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        map.set(idKey(Number.parseInt(code ?? "", 16)), utf16(value ?? ""));
      }
    }
    for (const chunk of block.match(/beginbfrange[\s\S]*?endbfrange/g) ?? []) {
      const entries = chunk.matchAll(
        /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]{0,4096})\])/g,
      );
      for (const [, lo, hi, single, list] of entries) {
        const first = Number.parseInt(lo ?? "", 16);
        const last = Math.min(Number.parseInt(hi ?? "", 16), first + 65_535);
        if (list !== undefined) {
          const destinations = [...list.matchAll(/<([0-9a-fA-F]*)>/g)].map(([, hex]) => utf16(hex ?? ""));
          for (let code = first; code <= last; code += 1) {
            const destination = destinations[code - first];
            if (destination !== undefined && destination !== "") map.set(idKey(code), destination);
          }
          continue;
        }
        const base = utf16(single ?? "");
        for (let code = first; code <= last; code += 1) {
          const destination = nextInSequence(base, code - first);
          if (destination !== "") map.set(idKey(code), destination);
        }
      }
    }
    if (map.size > 0) maps.push(map);
  }
  return maps;
}

/** A glyph id as this module's keys spell it: four lower-case hex digits. */
function idKey(code: number): string {
  return code.toString(16).padStart(4, "0");
}

/**
 * The nth destination of a `bfrange`, WHICH INCREMENTS THE LAST CODE UNIT AND NOT
 * THE WHOLE STRING.
 *
 * That is the spec's rule, and following it is also what stops this throwing. A
 * destination is a UTF-16BE STRING, not a number: a ligature (`<00660069>`, "fi")
 * or anything outside the BMP (`<d83dde00>`, a surrogate pair) is eight hex digits,
 * and parsing the lot as one integer gives a value past U+10FFFF -- which is a
 * `RangeError: Invalid code point` out of `String.fromCodePoint`, thrown from a
 * test helper on a perfectly legal file. `bfchar` was always routed through
 * `utf16`; this side was not.
 *
 * A range that walks a code unit past 0xffff is malformed, and contributes nothing
 * rather than wrapping into a character the file did not mean.
 */
function nextInSequence(destination: string, offset: number): string {
  if (destination === "") return "";
  const last = destination.charCodeAt(destination.length - 1) + offset;
  return last > 0xffff ? "" : destination.slice(0, -1) + String.fromCharCode(last);
}

/** A CMap destination: UTF-16BE, so one code point can be four hex digits or eight. */
function utf16(hex: string): string {
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
  return out;
}
