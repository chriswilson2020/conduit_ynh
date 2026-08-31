import { describe, expect, it } from "vitest";
import {
  CSV_BOM, CSV_EOL, csvCell, csvDocument, csvRow, escapeCellValue, unescapeCellValue,
} from "./csv.js";

// The dialect's rules, each one broken on purpose somewhere below. A rule that
// no test can violate is a rule nobody knows is there -- see the plan's
// conventions on instruments that have never been shown to fail.

describe("csvCell", () => {
  it("leaves an ordinary value unquoted", () => {
    expect(csvCell("Acme Ltd")).toBe("Acme Ltd");
  });

  it("quotes a value containing the delimiter", () => {
    expect(csvCell("Acme, Ltd")).toBe('"Acme, Ltd"');
  });

  it("quotes a value containing a newline, and keeps the newline", () => {
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
  });

  it("quotes a value containing a carriage return", () => {
    expect(csvCell("line one\r\nline two")).toBe('"line one\r\nline two"');
  });

  it("doubles an embedded quote and wraps the result", () => {
    expect(csvCell('the "big" one')).toBe('"the ""big"" one"');
  });

  it("doubles every embedded quote, not only the first", () => {
    expect(csvCell('"a" and "b"')).toBe('"""a"" and ""b"""');
  });

  it("passes an accented value through unchanged", () => {
    // The two-byte sequence the BOM exists for, built from an escape so this
    // file stays ASCII.
    expect(csvCell("M\u00FCller GmbH")).toBe("M\u00FCller GmbH");
  });

  it("empty stays empty rather than becoming an empty quoted string", () => {
    expect(csvCell("")).toBe("");
  });
});

describe("csvCell formula neutralisation", () => {
  it("prefixes a leading = so a spreadsheet shows the text instead of #NAME?", () => {
    expect(csvCell("== Meeting summary ==")).toBe("'== Meeting summary ==");
  });

  it("prefixes a leading @", () => {
    expect(csvCell("@here please review")).toBe("'@here please review");
  });

  it("prefixes before quoting, so a formula containing a comma gets both", () => {
    expect(csvCell("=SUM(A1,B1)")).toBe('"\'=SUM(A1,B1)"');
  });

  // BOTH BYPASSES THE FIRST VERSION HAD, and both reached Excel as formulas.
  // Excel trims leading whitespace before deciding, and a sign in front of `=`
  // is not a number however much a bare sign is.
  it("sees through leading whitespace, which Excel trims before deciding", () => {
    // Unquoted: a tab is not one of the four characters RFC 4180 quotes for.
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
    expect(csvCell("  =1+1")).toBe("'  =1+1");
    expect(csvCell(" @sum")).toBe("' @sum");
  });

  it("sees through a leading sign, because +=1+1 is a formula and not a number", () => {
    expect(csvCell("+=1+1")).toBe("'+=1+1");
    expect(csvCell("-=1+1")).toBe("'-=1+1");
    expect(csvCell("+-@x")).toBe("'+-@x");
  });

  // The deliberate other half of the decision, and the one most likely to be
  // "fixed" by someone who has read an OWASP page and not this file's comment:
  // prefixing these would put a stray quote in front of every phone number and
  // every negative amount in the archive.
  it("leaves a leading + alone, so a phone number stays a phone number", () => {
    expect(csvCell("+31 6 12345678")).toBe("+31 6 12345678");
  });

  it("leaves a leading - alone, so a negative amount stays a number", () => {
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell("--strikethrough")).toBe("--strikethrough");
  });

  it("only looks at the start", () => {
    expect(csvCell("total = 5")).toBe("total = 5");
    expect(csvCell("chris@example.com")).toBe("chris@example.com");
  });
});

// THE RULING: the guard stays, but it has to be REVERSIBLE, because 7.7's exact
// importer is a declared consumer of this file and an export that silently
// rewrites the operator's notes is not acceptable. Doubling a leading
// apostrophe is what makes "remove exactly one" total.
describe("escapeCellValue / unescapeCellValue", () => {
  it("doubles an apostrophe a value genuinely starts with", () => {
    expect(escapeCellValue("'quoted")).toBe("''quoted");
    // Without the doubling this is the ambiguity: a stored `'=x` and a guarded
    // `=x` would both be written `'=x` and could not be told apart on the way
    // back in.
    expect(escapeCellValue("'=x")).toBe("''=x");
    expect(escapeCellValue("=x")).toBe("'=x");
    expect(escapeCellValue("'=x")).not.toBe(escapeCellValue("=x"));
  });

  // The property the manifest's declared transform promises, over every shape
  // the guard can see.
  const values = [
    "", "Acme Ltd", "M\u00FCller GmbH", "-12.50", "+31 6 12345678",
    "=SUM(A1,B1)", "@here", "== Zusammenfassung ==", "+=1+1", "-=1+1", "\t=1+1", "  @x",
    "'", "'x", "'=x", "''already", "total = 5", "a,b", 'the "big" one', "line\r\nbreak",
  ];

  it("round-trips every value through escape and back", () => {
    for (const value of values) {
      expect(unescapeCellValue(escapeCellValue(value)), JSON.stringify(value)).toBe(value);
    }
  });

  it("is injective, so no two stored values collide on one escaped form", () => {
    const escaped = values.map(escapeCellValue);
    expect(new Set(escaped).size).toBe(new Set(values).size);
  });

  // The instrument for the round trip, shown failing: without the doubling arm
  // the transform is not invertible, and this is the pair that proves it.
  it("would not round-trip if a leading apostrophe were left alone", () => {
    const naive = (value: string): string => (/^\s*[+-]*[=@]/.test(value) ? `'${value}` : value);
    expect(unescapeCellValue(naive("'=x"))).toBe("=x");
    expect(unescapeCellValue(naive("'=x"))).not.toBe("'=x");
  });
});

describe("csvRow", () => {
  it("joins with commas and terminates with CRLF", () => {
    expect(csvRow(["a", "b", "c"])).toBe(`a,b,c${CSV_EOL}`);
    expect(CSV_EOL).toBe("\r\n");
  });

  it("terminates with CRLF and not a bare LF", () => {
    const row = csvRow(["a"]);
    expect(row.endsWith("\r\n")).toBe(true);
    expect(row.slice(0, -2).includes("\n")).toBe(false);
  });

  it("never emits the BOM -- that belongs to the document, not a record", () => {
    expect(csvRow(["a", "b"])).not.toContain(CSV_BOM);
  });

  it("emits an empty field for an empty cell rather than skipping it", () => {
    expect(csvRow(["a", "", "c"])).toBe(`a,,c${CSV_EOL}`);
  });
});

describe("csvDocument", () => {
  it("starts with the UTF-8 BOM bytes EF BB BF, exactly once", () => {
    const bytes = csvDocument(["name"], [["Acme"]]);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // Once, not once per record: a second BOM lands mid-file as a stray
    // zero-width character in a cell.
    let count = 0;
    for (let i = 0; i + 2 < bytes.length; i += 1) {
      if (bytes[i] === 0xef && bytes[i + 1] === 0xbb && bytes[i + 2] === 0xbf) count += 1;
    }
    expect(count).toBe(1);
  });

  // THE PROOF, NOT THE ASSERTION. Both halves are decoded here: the bytes read
  // as UTF-8 give the right name, and the SAME bytes with the BOM removed and
  // read as cp1252 -- which is what a spreadsheet does to a BOM-less file on a
  // Western European machine -- give the mojibake the BOM exists to prevent. An
  // implementation that dropped the BOM would still pass the first half alone.
  it("makes an accented name survive, where the same bytes without the BOM do not", () => {
    const withBom = csvDocument(["name"], [["M\u00FCller GmbH"]]);
    expect(withBom.toString("utf8")).toContain("M\u00FCller GmbH");

    const withoutBom = withBom.subarray(3);
    expect(withoutBom.toString("latin1")).toContain("M\u00C3\u00BCller GmbH");
    expect(withoutBom.toString("latin1")).not.toContain("M\u00FCller GmbH");
  });

  it("writes the header first, then one record per row", () => {
    const bytes = csvDocument(["id", "name"], [["1", "Acme"], ["2", "Beta"]]);
    expect(bytes.toString("utf8")).toBe(`${CSV_BOM}id,name\r\n1,Acme\r\n2,Beta\r\n`);
  });

  it("writes a header-only document when there are no rows", () => {
    const bytes = csvDocument(["id", "name"], []);
    expect(bytes.toString("utf8")).toBe(`${CSV_BOM}id,name\r\n`);
  });

  it("is UTF-8, so one accented character is two bytes and not one", () => {
    const bytes = csvDocument(["n"], [["\u00FC"]]);
    // BOM(3) + "n" + CRLF(2) + the two bytes of u-umlaut + CRLF(2)
    expect(bytes.byteLength).toBe(3 + 1 + 2 + 2 + 2);
  });
});
