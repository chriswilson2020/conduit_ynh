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
 * lost the run is exactly the vacuous pass this module exists to prevent. `textRuns`
 * reads `TJ`, `Tj`, `'` and `"`, hex strings and literal ones alike, and names the
 * two shapes it still does not read and why. None of them occurs in either renderer
 * here -- measured on a real quote, 25 text operators, all 25 matched, and not one
 * literal-string operator in the file -- but "none today" is the whole of that
 * claim, which is why the two remaining gaps are written down rather than implied.
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
  const { hex, literal } = textRuns(text);
  const decoded = toUnicodeMaps(text).map((map) => hex.map((run) => decodeRun(run, map)).join("\n"));
  // The literal strings are characters already and go through no map, so they are
  // added ONCE rather than once per CMap.
  return [...decoded, ...literal].join("\n");
}

/**
 * Every text-showing operator's payload, one entry per operator, split by how it
 * has to be read: `hex` strings go through a `/ToUnicode` CMap, `literal` strings
 * are already characters.
 *
 * NO LENGTH BOUND ON THE ARRAY BODY, AND REMOVING IT FIXED A BUG RATHER THAN
 * RELAXING ONE. An earlier version wrote `[^\]]{0,4096}` as a belt-and-braces
 * measure. `[^\]]` cannot backtrack, so the bound bought no performance -- and it
 * REINSTATED exactly the defect the `bfrange` alternation was added to close: an
 * array longer than the bound fails to match, `matchAll` advances into it, and its
 * own first elements are re-read as though they were a different construct. A
 * 600-entry destination array came back as two invented characters with the real
 * line gone. An unbounded negated class is both faster to reason about and correct.
 *
 * WHITE SPACE INSIDE `<...>` IS PART OF THE STRING'S SYNTAX AND IS IGNORED, per
 * ISO 32000-1 7.3.4.3 -- `<0024 0044>` is two codes. `decodeRun` strips it. A
 * producer that wraps long lines emits this, and so does anything that has been
 * through a `qpdf` pass, whatever the original looked like. Without it the run
 * misaligns and the whole line decodes to nothing, which is the silent-loss shape
 * this module exists to avoid.
 *
 * THE LITERAL-STRING OPERATORS ARE GATED INSIDE `BT..ET`, AND THAT GATE IS THE
 * WHOLE REASON THEY CAN BE READ AT ALL. `(...) Tj` is what a font with a simple
 * encoding produces, and scanning for it across the megabytes of inflated font and
 * image data `pdfText` hands over would match binary noise: measured over 128MB of
 * random bytes, an ungated scan found 6 spurious matches and invented 1,892
 * characters. Gated inside a text object, the same 128MB produced ZERO -- and
 * every show operator any real producer writes is inside `BT..ET` by definition,
 * because that is what a text object is. So the choice this comment once called an
 * impossibility is a gate, and the gate is cheap.
 *
 * WHAT IS STILL NOT READ, so nobody has to rediscover it: a `TJ` array whose body
 * contains a literal string with a `]` inside it, and a nested array. Both stop
 * the negated class early and truncate the run. Neither WeasyPrint here writes
 * either -- measured on a real quote, 25 text operators, all 25 matched -- but a
 * truncated run is missing text, and missing text is what makes a `not.toContain`
 * pass for the wrong reason. See `pdfVisibleText` for the pairing that is the
 * actual protection.
 */
interface TextRuns {
  /** Glyph ids, to be decoded through each CMap. */
  readonly hex: string[];
  /** Characters already, from a simple-encoding font. */
  readonly literal: string[];
}

function textRuns(text: string): TextRuns {
  const hex: string[] = [];
  // A TJ array: hex strings separated by kerning numbers, all one line. The `?? ""`
  // on every capture is `noUncheckedIndexedAccess`: a group that matched cannot be
  // undefined, and the compiler has no way to know that.
  for (const [, body] of text.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    hex.push([...(body ?? "").matchAll(/<([0-9a-fA-F\s]*)>/g)].map(([, run]) => run ?? "").join(""));
  }
  // Tj shows a string; ' and " show one and move to the next line first.
  for (const [, run] of text.matchAll(/<([0-9a-fA-F\s]*)>\s*(?:Tj|'|")/g)) hex.push(run ?? "");

  const literal: string[] = [];
  for (const [, block] of text.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
    for (const run of literalStrings(block ?? "")) literal.push(run);
  }
  return { hex, literal };
}

/**
 * The literal strings shown by `Tj`, `'` or `"` inside one text object.
 *
 * Scanned rather than matched with a regex because a PDF literal string NESTS
 * parentheses and escapes them with a backslash, so `(a\)b)` is one string and
 * `((x))` is another -- neither of which a `\(([^)]*)\)` pattern reads correctly,
 * and reading one incorrectly is how invented text gets into the output.
 */
function literalStrings(block: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== "(") continue;
    let depth = 1;
    let value = "";
    let j = i + 1;
    for (; j < block.length && depth > 0; j += 1) {
      const ch = block[j];
      if (ch === "\\") {
        const next = block[j + 1] ?? "";
        // The escapes that stand for a character; a backslash before anything
        // else is dropped, which is what the spec says.
        value += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[next] ?? next;
        j += 1;
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      if (depth > 0 && ch !== undefined) value += ch;
    }
    // Only a string that is actually SHOWN counts. Anything else in a text object
    // -- a font name, an operand of some other operator -- is not on the page.
    if (/^\s*(?:Tj|'|")/.test(block.slice(j))) found.push(value);
    i = j - 1;
  }
  return found;
}

/**
 * Two-byte codes through one CMap; an id the map does not carry contributes
 * nothing.
 *
 * WHITE SPACE IS STRIPPED FIRST, because ISO 32000-1 7.3.4.3 says a hexadecimal
 * string ignores it -- `<0024 0044>` is two codes and not a malformed one. It is
 * what a line-wrapping producer emits, and what a `qpdf` pass downstream of one
 * will emit whatever the original looked like. Without the strip the run's length
 * is wrong, every code after the space is misaligned, and the whole line silently
 * decodes to nothing: a MISSING run, which is the shape that makes a
 * `not.toContain` pass for the wrong reason.
 */
function decodeRun(run: string, map: ReadonlyMap<string, string>): string {
  const hex = run.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) out += map.get(hex.slice(i, i + 4).toLowerCase()) ?? "";
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
      for (const [, code, value] of chunk.matchAll(/<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]+)>/g)) {
        const id = codeOf(code);
        if (id !== null) map.set(idKey(id), utf16(value ?? ""));
      }
    }
    for (const chunk of block.match(/beginbfrange[\s\S]*?endbfrange/g) ?? []) {
      const entries = chunk.matchAll(
        /<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]+)>\s*(?:<([0-9a-fA-F\s]+)>|\[([^\]]*)\])/g,
      );
      for (const [, lo, hi, single, list] of entries) {
        const first = codeOf(lo);
        const end = codeOf(hi);
        if (first === null || end === null) continue;
        const last = Math.min(end, first + 65_535);
        if (list !== undefined) {
          // BOTH ELEMENT KINDS ARE COUNTED, and that is the point rather than
          // completeness: an array element may legally be a `/name` instead of a
          // hex string, and skipping one shifts every destination after it by a
          // place -- ids quietly mapped to their neighbour's character. A name is
          // a glyph name this reader cannot resolve to a character, so it maps to
          // nothing; it still takes its slot.
          const destinations = [...list.matchAll(/<([0-9a-fA-F\s]*)>|\/[^\s<>[\]/]+/g)]
            .map(([, hex]) => (hex === undefined ? "" : utf16(hex)));
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
 * A code from the file, as a number, or null if it is not a two-byte one.
 *
 * BOTH HALVES MATTER. White space inside a hexadecimal string is ignored by the
 * spec, so `<00 41>` is the same code as `<0041>`. And the WIDTH IS CHECKED
 * rather than normalised away: `decodeRun` reads the content stream two bytes at
 * a time, so a one-byte or three-byte code belongs to a codespace this reader
 * does not decode, and folding it into a four-digit key would make `<000041>`
 * collide with `<0041>` -- two different codes silently sharing an entry, which
 * the string keys this replaced did not do. Refusing it is the honest handling.
 */
function codeOf(hex: string | undefined): number | null {
  const clean = (hex ?? "").replace(/\s+/g, "");
  if (clean.length !== 4) return null;
  return Number.parseInt(clean, 16);
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
  const base = destination.charCodeAt(destination.length - 1);
  const last = base + offset;
  if (last > 0xffff) return "";
  // AND IT MAY NOT WALK OUT OF A SURROGATE HALF. A destination outside the BMP
  // ends in a LOW surrogate (0xdc00-0xdfff), and incrementing past 0xdfff leaves
  // a high surrogate followed by an ordinary character -- a lone surrogate, which
  // is not the text any producer wrote. Same at the top of the high half. The
  // range simply stops contributing there rather than inventing a character.
  if (base >= 0xdc00 && base <= 0xdfff && last > 0xdfff) return "";
  if (base >= 0xd800 && base <= 0xdbff && last > 0xdbff) return "";
  return destination.slice(0, -1) + String.fromCharCode(last);
}

/** A CMap destination: UTF-16BE, so one code point can be four hex digits or eight. */
function utf16(hex: string): string {
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
  return out;
}
