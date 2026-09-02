import { StringDecoder } from "node:string_decoder";

// The CSV dialect the export writes AND READS BACK. RFC 4180, and every part
// of it is a decision rather than a default -- see the 7.6 spec's Export
// section.
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
//
// SINCE 7.7 THIS MODULE ALSO READS, and the reader lives here rather than in
// the importer for the reason unescapeCellValue already lived here: a parser
// written next door would be a SECOND description of the dialect, and the day
// the two disagreed the file nobody could open would be the operator's only
// copy of their data. csvRecords below is the inverse of csvDocument, and
// csv.test.ts asserts the round trip over the writer's own output rather than
// over strings a reader hand-wrote to suit itself.
//
// THE READER IS STRICT WHERE THE WRITER IS SPECIFIC, and that is the whole
// difference between it and the forgiving sniffer 7.7's OTHER importer needs.
// This one reads a file THIS MODULE WROTE, whose bytes have already been
// checked against a SHA-256 in manifest.json before a record is parsed. So a
// lone LF outside quotes, a quote in the middle of an unquoted field, a record
// with a different number of fields from the header -- none of them can occur
// in an undamaged export, and every one of them means the parse has lost its
// place. Guessing at that point would misassign every column of every row that
// followed, silently. It throws instead.

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

// --- Reading the dialect back (7.7) --------------------------------------

/**
 * The parse lost its place, and the record number where it happened.
 *
 * A THROW RATHER THAN A SKIPPED ROW, and the difference is not squeamishness.
 * Every condition that raises this means the parser no longer knows which
 * character belongs to which column -- so the NEXT row would be misassigned
 * too, and the one after that, with a plausible-looking company name landing in
 * `domain` and nothing on screen to say so. A file this reader cannot follow is
 * one the importer must refuse whole.
 *
 * `record` COUNTS FROM 1 AND THE HEADER IS RECORD 1, because that is what a
 * person looking at the file in a spreadsheet sees in the row gutter.
 */
export class CsvParseError extends Error {
  constructor(readonly record: number, message: string) {
    super(`the CSV could not be read at record ${String(record)}: ${message}`);
    this.name = "CsvParseError";
  }
}

/**
 * The most characters one record may hold before the reader gives up.
 *
 * 8 MILLION, AND IT BOUNDS MEMORY RATHER THAN PLAUSIBILITY. The reader streams
 * precisely so a 100MB sheet never exists as a string -- but an unterminated
 * quote turns the WHOLE REMAINDER of the file into one field, so without a
 * bound the streaming buys nothing against exactly the malformed input it
 * exists to survive. Well above anything the writer produces: the largest cell
 * this export has is a meeting's sanitised HTML, and eight million characters
 * is a document nobody typed.
 */
export const DEFAULT_MAX_RECORD_CHARS = 8_000_000;

/**
 * THE INVERSE OF csvDocument, ONE RECORD AT A TIME.
 *
 * STREAMING, AND THAT IS A REQUIREMENT RATHER THAN A REFINEMENT. A sheet is
 * read twice by the importer -- once to build the plan, once to apply it -- and
 * services/intake.ts's readText refuses a member over 64MB for the reason its
 * own comment gives. 200,000 notes rows are 103MB of CSV (measured in 7.6, see
 * services/export.ts), so the only way to read this install's own export back
 * is a record at a time, with nothing but the current record resident.
 *
 * THE BOM IS CONSUMED ONLY AT THE VERY START OF THE DOCUMENT. csvDocument emits
 * exactly one, before the header; a U+FEFF anywhere else is a character in
 * somebody's data -- a legal, if unkind, thing to type -- and is kept.
 *
 * THE CELL TRANSFORM IS NOT REVERSED HERE, deliberately. unescapeCellValue is
 * applied by the importer, and only when manifest.json DECLARES the transform
 * -- see services/import-export.ts. A reader that always un-escaped would
 * silently eat a leading apostrophe out of an archive that never added one.
 *
 * Accepts an async iterable of Buffers (a staged member's read stream) or of
 * strings (a test's literal). A multi-byte character split across two Buffers
 * is reassembled by StringDecoder, so no chunking makes this see half of one.
 */
export async function* csvRecords(
  source: AsyncIterable<Buffer | string>,
  options: { maxRecordChars?: number } = {},
): AsyncGenerator<string[]> {
  const maxRecordChars = options.maxRecordChars ?? DEFAULT_MAX_RECORD_CHARS;
  const decoder = new StringDecoder("utf8");

  let record: string[] = [];
  let field = "";
  let recordChars = 0;
  let recordNumber = 1;
  /** Whether any character of the document has been seen. For the BOM only. */
  let started = false;
  let inQuotes = false;
  /** Inside a quoted field, having just read a `"` whose meaning is undecided. */
  let quotePending = false;
  /** Outside quotes, having just read a `\r` that must be followed by `\n`. */
  let crPending = false;
  /** The current field opened with a quote. */
  let fieldQuoted = false;
  /** Anything at all has been consumed into the current field. */
  let fieldConsumed = false;

  const fail = (message: string): never => {
    throw new CsvParseError(recordNumber, message);
  };

  function* consume(text: string): Generator<string[]> {
    for (const ch of text) {
      if (!started) {
        started = true;
        if (ch === CSV_BOM) continue;
      }
      recordChars += 1;
      if (recordChars > maxRecordChars) {
        fail(
          `it is longer than the ${String(maxRecordChars)} characters this reader accepts, `
          + "which usually means a quoted field was never closed",
        );
      }
      if (crPending) {
        crPending = false;
        if (ch !== "\n") {
          fail("a carriage return outside a quoted field was not followed by a line feed");
        }
        record.push(field);
        field = "";
        fieldQuoted = false;
        fieldConsumed = false;
        recordChars = 0;
        yield record;
        record = [];
        recordNumber += 1;
        continue;
      }
      if (quotePending) {
        quotePending = false;
        if (ch === '"') { field += '"'; continue; }
        // The quote closed the field. Only a delimiter or a record terminator
        // may follow it; anything else means these bytes were not written by
        // csvCell, whose escaping is the only thing this reader undoes.
        inQuotes = false;
        if (ch === ",") {
          record.push(field);
          field = "";
          fieldQuoted = false;
          fieldConsumed = false;
          continue;
        }
        if (ch === "\r") { crPending = true; continue; }
        fail("a quoted field ended in the middle of a value");
      }
      if (inQuotes) {
        if (ch === '"') { quotePending = true; continue; }
        field += ch;
        continue;
      }
      if (ch === '"') {
        if (fieldConsumed || fieldQuoted) fail("a quote appeared inside an unquoted field");
        inQuotes = true;
        fieldQuoted = true;
        fieldConsumed = true;
        continue;
      }
      if (ch === ",") {
        record.push(field);
        field = "";
        fieldQuoted = false;
        fieldConsumed = false;
        continue;
      }
      if (ch === "\r") { crPending = true; continue; }
      if (ch === "\n") fail("a line feed outside a quoted field was not preceded by a carriage return");
      field += ch;
      fieldConsumed = true;
    }
  }

  for await (const chunk of source) {
    yield* consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
  }
  yield* consume(decoder.end());

  // THE END OF THE FILE IS A STATE THIS HAS TO CHECK, and it is the one a
  // truncated download reaches. csvDocument terminates EVERY record with CRLF,
  // so a well-formed document ends with the parser idle: no open quote, no
  // pending carriage return, and no half-built record. Anything else is a file
  // that stopped early, and saying so is the difference between an import that
  // refuses and one that silently loses its last rows.
  if (inQuotes && !quotePending) fail("the file ended inside a quoted field");
  if (crPending) fail("the file ended after a carriage return with no line feed");
  if (quotePending || fieldConsumed || record.length > 0) {
    fail("the file ended without terminating its last record");
  }
}
