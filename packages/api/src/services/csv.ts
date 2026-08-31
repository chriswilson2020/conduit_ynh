// The CSV dialect the export writes. RFC 4180, and every part of it is a
// decision rather than a default -- see the 7.6 spec's Export section.
//
// THE ONE AUDIENCE IS A SPREADSHEET. The export exists so an operator can open
// their data in Excel; nothing else consumes it, and the backup (Task 2) is the
// artefact that is exact rather than readable. So where RFC 4180 leaves a
// choice, the choice is made in favour of what Excel does with the bytes, and
// where Excel and the RFC disagree the disagreement is written down here rather
// than discovered by someone looking at a column of `#NAME?`.
//
// The dialect lives in its own module, apart from the row-building in
// export.ts, because it is the part with rules -- and a rule nobody can break
// on purpose in a test is a rule nobody knows is there.

/**
 * U+FEFF, encoded UTF-8 as EF BB BF, at the very start of the file.
 *
 * WITHOUT THIS THE EXPORT LOOKS BROKEN TO THE ONLY PEOPLE IT IS FOR. Excel does
 * not sniff UTF-8: opening a BOM-less CSV on a Western European machine decodes
 * it as the system code page (cp1252 on Windows, MacRoman-ish elsewhere), so
 * the two bytes C3 BC that spell `u` with an umlaut come out as two separate
 * characters and `Muller` -- with the umlaut -- arrives as `MA1/4ller`. The BOM
 * is the one signal Excel does honour, and it costs three bytes.
 *
 * It is a property of the DOCUMENT, not of a row, so it is emitted exactly once
 * by csvDocument below and never by csvRow.
 *
 * Spelled as an escape, not as the literal character: U+FEFF is
 * zero-width, so a literal here would be an invisible edit away from being
 * deleted by an editor that trims, and this file is otherwise ASCII.
 */
export const CSV_BOM = "\uFEFF";

/**
 * The record separator. CRLF, not LF: RFC 4180 says CRLF, and it is what every
 * spreadsheet on every platform reads back unambiguously. A field's own
 * embedded newlines survive because such a field is quoted (see csvCell).
 */
export const CSV_EOL = "\r\n";

/**
 * Characters that, at the START of a cell, make a spreadsheet treat the cell as
 * a formula instead of text.
 *
 * `=` and `@` ONLY, and the two that are missing are the point of the comment.
 *
 * Neutralising a leading `=` is not primarily about a hostile `=cmd|...` DDE
 * payload, which modern Excel refuses to run without several explicit prompts.
 * It is about the ordinary case: a note whose body begins `== Meeting summary`
 * is a formula Excel cannot evaluate, so the cell shows `#NAME?` and the
 * operator's note is INVISIBLE. Prefixing it makes the cell read
 * `'== Meeting summary`, which is one stray character in front of text the
 * operator can still read. Both directions of the trade favour prefixing.
 *
 * `+` and `-` are DELIBERATELY ABSENT, and that is the opposite trade on the
 * same reasoning. Both begin legitimate values in columns this export
 * ships -- a phone number `+31 6 ...`, a negative amount `-1250` becoming
 * `-12.50` -- and a spreadsheet renders both of those correctly as-is. Adding
 * them to this set would put a `'` in front of every phone number and every
 * credit in the file to defuse a formula that, for those two characters,
 * evaluates to a number rather than hiding the cell. That is a visible,
 * certain corruption of common data traded against an invisible, rare one.
 *
 * Documented as a judgement call rather than a rule handed down: the spec asks
 * for RFC 4180 and a BOM and says nothing about formulas.
 */
const FORMULA_LEAD = /^[=@]/;

/**
 * One field, in the dialect.
 *
 * QUOTED WHEN IT HAS TO BE, which per RFC 4180 means it contains the quote
 * character, the delimiter, or either half of a line break. Quoting more than
 * that would be harmless but would make every diff of an export noisier than
 * the data that changed.
 *
 * The doubling rule (`"` becomes `""`) is applied INSIDE the quotes and only
 * there, which is the whole of RFC 4180's escaping. There is no backslash
 * escape in CSV and adding one would be a private dialect.
 *
 * The formula prefix is applied BEFORE the quoting decision, not after, so a
 * cell like `=1,2` gets both treatments and in the right order: the `'` goes on
 * the value, and the value is then quoted because it contains a comma.
 */
export function csvCell(value: string): string {
  const guarded = FORMULA_LEAD.test(value) ? `'${value}` : value;
  if (!/["\r\n,]/.test(guarded)) return guarded;
  return `"${guarded.replaceAll('"', '""')}"`;
}

/** One record: cells joined by the delimiter, terminated by CRLF. */
export function csvRow(cells: readonly string[]): string {
  return cells.map(csvCell).join(",") + CSV_EOL;
}

/**
 * A whole CSV file as a UTF-8 Buffer: BOM, header record, then one record per
 * row.
 *
 * Returns BYTES rather than a string because bytes are what the archive member
 * and the manifest's SHA-256 are both made of, and because the BOM's whole job
 * is a property of the encoded form -- a caller handed a string could still
 * write it as something other than UTF-8 and undo the only reason it is here.
 */
export function csvDocument(header: readonly string[], rows: readonly (readonly string[])[]): Buffer {
  const parts = [CSV_BOM + csvRow(header)];
  for (const row of rows) parts.push(csvRow(row));
  return Buffer.from(parts.join(""), "utf8");
}
