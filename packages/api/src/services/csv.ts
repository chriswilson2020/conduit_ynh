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
 * Values that a spreadsheet would treat as a FORMULA rather than as text.
 *
 * WHAT IS MATCHED, and every part of it was paid for. After any leading
 * whitespace, an optional run of `+` or `-`, then `=` or `@`.
 *
 * Neutralising a leading `=` is not primarily about a hostile `=cmd|...` DDE
 * payload, which modern Excel refuses to run without several explicit prompts.
 * It is the ordinary case: a note whose body begins `== Meeting summary` is a
 * formula Excel cannot evaluate, so the cell shows `#NAME?` and the operator's
 * note is INVISIBLE. One stray character in front of readable text is the
 * better half of that trade in both directions.
 *
 * `+` and `-` ARE NOT MATCHED ON THEIR OWN, deliberately, and that is the
 * opposite trade on the same reasoning: both begin legitimate values this
 * export ships -- a phone number `+31 6 ...`, a credit of `-12.50` -- and a
 * spreadsheet renders both correctly as they are. Guarding them would put an
 * apostrophe in front of every phone number and every credit in the file.
 *
 * BUT A SIGN FOLLOWED BY `=` IS NOT A NUMBER. `+=1+1` reached Excel as a
 * formula under the first version of this rule, which anchored on the first
 * character alone; so did a tab before `=1+1`, because Excel trims leading
 * whitespace before deciding. The `[+-]*` run and the leading `\s*` close both
 * without touching `+31 6 12345678` (whose next character is a digit) or
 * `-12.50`.
 */
const FORMULA_LEAD = /^\s*[+-]*[=@]/;

/**
 * The escape character, and the reason the transform below is INVERTIBLE.
 *
 * A cell already starting with an apostrophe is prefixed with a second one, so
 * "remove exactly one leading apostrophe" recovers the stored value in every
 * case -- a formula that was guarded, an apostrophe that was doubled, or a
 * value that was left alone and so never starts with one.
 *
 * WITHOUT THAT DOUBLING THE EXPORT IS LOSSY, and lossy for the one consumer
 * `formatVersion` exists to serve: 7.7's exact importer cannot tell a guarded
 * `=x` from a stored `'=x`, and a note reading `@here please review` comes back
 * as `'@here please review` for ever. The transform is declared in
 * manifest.json as a named, versioned entry (EXPORT_CELL_TRANSFORM in
 * services/export.ts) so that importer undoes it deterministically rather than
 * guessing at it.
 */
const CELL_ESCAPE = "'";

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
 * The escape is applied BEFORE the quoting decision, not after, so a cell like
 * `=1,2` gets both treatments and in the right order: the apostrophe goes on
 * the value, and the value is then quoted because it contains a comma.
 */
export function csvCell(value: string): string {
  const guarded = escapeCellValue(value);
  if (!/["\r\n,]/.test(guarded)) return guarded;
  return `"${guarded.replaceAll('"', '""')}"`;
}

/**
 * The reversible half of the dialect, exported so its inverse can be written
 * against it rather than inferred from it.
 *
 * An apostrophe is prefixed when the value would read as a formula, OR when it
 * already starts with one. Those two arms together are what make
 * unescapeCellValue total.
 */
export function escapeCellValue(value: string): string {
  const needsEscape = value.startsWith(CELL_ESCAPE) || FORMULA_LEAD.test(value);
  return needsEscape ? CELL_ESCAPE + value : value;
}

/**
 * The exact inverse of escapeCellValue: remove one leading apostrophe if there
 * is one.
 *
 * Lives beside the transform so the two cannot drift, and so 7.7's importer has
 * a definition to copy rather than a sentence to interpret. The round trip is
 * asserted over a table of values in csv.test.ts.
 */
export function unescapeCellValue(value: string): string {
  return value.startsWith(CELL_ESCAPE) ? value.slice(CELL_ESCAPE.length) : value;
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
