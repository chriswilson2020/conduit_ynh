import { describe, it, expect } from "vitest";
import {
  DOCUMENT_CONTENT_BUDGET_BYTES, DOCUMENT_MAX_DESCRIPTION_CHARS, DOCUMENT_MAX_LINES, documentTotals,
} from "@conduit/shared";
import {
  QTY_SPEC, TAX_RATE_SPEC, UNIT_PRICE_SPEC,
  buildIssueQuoteInput, contentBudget, parseUnits, runningTotals, unitsOrZero,
} from "./document-lib";
import type { DraftLine, DraftQuote } from "./document-lib";

function line(over: Partial<DraftLine> = {}): DraftLine {
  return { id: "l1", description: "Consultancy", qty: "1", unitPrice: "100", taxRate: "21", ...over };
}

/** Every field at its cap, filled with one repeated character. */
function maxedDraft(fill: string): DraftQuote {
  const description = fill.repeat(DOCUMENT_MAX_DESCRIPTION_CHARS);
  return draft({
    lines: Array.from({ length: DOCUMENT_MAX_LINES }, (_, i) => line({ id: `l${String(i)}`, description })),
    recipientAddress: fill.repeat(2000),
    notes: fill.repeat(5000),
    terms: fill.repeat(5000),
  });
}

function draft(over: Partial<DraftQuote> = {}): DraftQuote {
  return {
    issueDate: "2026-08-29",
    validUntilDate: "",
    recipientName: "Acme Ltd",
    recipientContactName: "",
    recipientAddress: "",
    notes: "",
    terms: "",
    lines: [line()],
    ...over,
  };
}

describe("parseUnits", () => {
  it("shifts a decimal into its smallest unit exactly", () => {
    expect(parseUnits("1.5", QTY_SPEC)).toEqual({ kind: "ok", units: 1500 });
    expect(parseUnits("1250.00", UNIT_PRICE_SPEC)).toEqual({ kind: "ok", units: 125_000 });
    expect(parseUnits("21", TAX_RATE_SPEC)).toEqual({ kind: "ok", units: 2100 });
    expect(parseUnits("0", QTY_SPEC)).toEqual({ kind: "ok", units: 0 });
  });

  /**
   * THE REASON THIS FILE DOES NOT USE `Number()`, pinned as a test rather than
   * left in a comment -- and the pinning earned its keep immediately: the first
   * version of this test asserted that 1.115 * 1000 loses precision, which it
   * does not, and the suite said so. These three DO, and are the measured ones.
   *
   * What each costs is worth being precise about, because they fail in two
   * different directions. A float multiply lands just off an integer, and
   * `documentTotals` demands a SAFE INTEGER and throws -- so the naive
   * conversion does not quietly store a wrong number, it takes the form down.
   * Rounding it would swap that crash for the off-by-one-cent defect the spec
   * names as this feature's classic one. The string shift has neither problem.
   */
  it("is exact where a float multiply is not", () => {
    expect(parseUnits("1.001", QTY_SPEC)).toEqual({ kind: "ok", units: 1001 });
    expect(1.001 * 1000).not.toBe(1001);
    expect(Number.isSafeInteger(1.001 * 1000)).toBe(false);

    expect(parseUnits("8.87", UNIT_PRICE_SPEC)).toEqual({ kind: "ok", units: 887 });
    expect(8.87 * 100).not.toBe(887);

    expect(parseUnits("17.17", UNIT_PRICE_SPEC)).toEqual({ kind: "ok", units: 1717 });
    expect(17.17 * 100).not.toBe(1717);

    expect(parseUnits("1.005", QTY_SPEC)).toEqual({ kind: "ok", units: 1005 });
    expect(1.005 * 1000).not.toBe(1005);
  });

  it("accepts a comma separator, like the rest of this app's number fields", () => {
    expect(parseUnits("1,5", QTY_SPEC)).toEqual({ kind: "ok", units: 1500 });
    expect(parseUnits("1250,00", UNIT_PRICE_SPEC)).toEqual({ kind: "ok", units: 125_000 });
  });

  /**
   * THE HALF-TYPED STATES, EVERY ONE THE PLAN NAMES. None may throw and none
   * may reach documentTotals as a non-integer; each is either empty or an
   * invalid with a sentence.
   */
  it("calls an empty field empty, not invalid", () => {
    expect(parseUnits("", QTY_SPEC)).toEqual({ kind: "empty" });
    expect(parseUnits("   ", QTY_SPEC)).toEqual({ kind: "empty" });
  });

  it("refuses a lone separator", () => {
    expect(parseUnits(".", QTY_SPEC).kind).toBe("invalid");
    expect(parseUnits(",", QTY_SPEC).kind).toBe("invalid");
  });

  it("accepts a trailing or leading separator, because both are real numbers", () => {
    // "1." and ".5" are what a keyboard produces halfway through "1.5" and
    // "0.5". Both are unambiguous, so they parse rather than nag.
    expect(parseUnits("1.", QTY_SPEC)).toEqual({ kind: "ok", units: 1000 });
    expect(parseUnits(".5", QTY_SPEC)).toEqual({ kind: "ok", units: 500 });
  });

  it("refuses a bare minus and any negative", () => {
    expect(parseUnits("-", QTY_SPEC).kind).toBe("invalid");
    expect(parseUnits("-1", QTY_SPEC).kind).toBe("invalid");
    expect(parseUnits("-0.5", UNIT_PRICE_SPEC).kind).toBe("invalid");
  });

  /**
   * `Number("1e5")` is 100000 and `Number("0x10")` is 16. Neither is something
   * a person means to type into a quantity box, and accepting them would let a
   * value into the arithmetic that the field's own ceiling never saw.
   */
  it("refuses exponent, hex, infinity and a leading plus", () => {
    for (const text of ["1e5", "1E5", "0x10", "Infinity", "+1", "1 000", "abc"]) {
      expect(parseUnits(text, QTY_SPEC).kind, text).toBe("invalid");
    }
  });

  it("refuses more decimal places than the unit carries, rather than rounding one away", () => {
    expect(parseUnits("1.2345", QTY_SPEC).kind).toBe("invalid");
    expect(parseUnits("1.234", QTY_SPEC).kind).toBe("ok");
    expect(parseUnits("1.234", UNIT_PRICE_SPEC).kind).toBe("invalid");
    expect(parseUnits("1.23", UNIT_PRICE_SPEC).kind).toBe("ok");
  });

  /**
   * THE CEILINGS ARE THE COLUMNS'. A value past one of them computed a correct
   * running total, passed documentTotals and died on the INSERT with a 22003
   * before Task 4's review bounded it -- so a form that let one through would
   * render a PDF and then answer 500.
   */
  it("refuses a value past the column that stores it, and accepts the value at it", () => {
    expect(parseUnits("2147483.647", QTY_SPEC)).toEqual({ kind: "ok", units: 2_147_483_647 });
    expect(parseUnits("2147483.648", QTY_SPEC).kind).toBe("invalid");
    expect(parseUnits("100", TAX_RATE_SPEC)).toEqual({ kind: "ok", units: 10_000 });
    expect(parseUnits("100.01", TAX_RATE_SPEC).kind).toBe("invalid");
    expect(parseUnits("90071992547409.91", UNIT_PRICE_SPEC)).toEqual({
      kind: "ok", units: Number.MAX_SAFE_INTEGER,
    });
    expect(parseUnits("90071992547409.92", UNIT_PRICE_SPEC).kind).toBe("invalid");
  });

  it("stays exact for a digit string far past what a double could hold", () => {
    // BigInt rather than Number is what makes the ceiling comparison sound:
    // this value rounds to MAX_SAFE_INTEGER as a double and would otherwise be
    // accepted as being exactly at the limit.
    expect(parseUnits("90071992547409.93", UNIT_PRICE_SPEC).kind).toBe("invalid");
    expect(Number("9007199254740993")).toBe(Number.MAX_SAFE_INTEGER + 1);
  });

  it("names the field it is talking about", () => {
    const problem = parseUnits("1e5", TAX_RATE_SPEC);
    expect(problem.kind).toBe("invalid");
    if (problem.kind === "invalid") expect(problem.message).toContain("tax rate");
  });
});

describe("unitsOrZero", () => {
  it("contributes zero for every state that is not a value", () => {
    expect(unitsOrZero({ kind: "empty" })).toBe(0);
    expect(unitsOrZero({ kind: "invalid", message: "x" })).toBe(0);
    expect(unitsOrZero({ kind: "ok", units: 7 })).toBe(7);
  });
});

describe("runningTotals", () => {
  it("agrees with the function the server stores with", () => {
    const lines = [line({ qty: "2", unitPrice: "1250.00", taxRate: "21" })];
    expect(runningTotals(lines)).toEqual(documentTotals([
      { qtyMilli: 2000, unitPriceCents: 125_000, taxRateBp: 2100 },
    ]));
  });

  /**
   * THE DEFECT THIS WHOLE MODULE EXISTS TO PREVENT. Every one of these is a
   * state a keyboard passes through, and calling documentTotals with the raw
   * text -- or with the NaN a float conversion makes of it -- throws inside
   * render. There is no error boundary in packages/web/src, so that throw
   * unmounts the form.
   */
  it("degrades to a partial figure while a field is half-typed, and never throws", () => {
    for (const partial of ["", ".", "1.", "-", "1e5", ",", "abc"]) {
      const lines = [
        line({ id: "a", qty: "2", unitPrice: "100", taxRate: "0" }),
        line({ id: "b", qty: partial, unitPrice: "100", taxRate: "0" }),
      ];
      const totals = runningTotals(lines);
      expect(totals, partial).not.toBeNull();
      // The complete line still counts; the half-typed one contributes zero,
      // except where the partial is itself a number ("1." is 1).
      const expected = partial === "1." ? 30_000 : 20_000;
      expect(totals?.totalCents, partial).toBe(expected);
    }
  });

  it("survives every field of every line being blank", () => {
    const blank = { id: "z", description: "", qty: "", unitPrice: "", taxRate: "" };
    expect(runningTotals([blank, blank])).toEqual({ subtotalCents: 0, taxCents: 0, totalCents: 0 });
  });

  /**
   * The null branch is REACHABLE, which is why it is a branch rather than
   * padding: both ceilings are per field, and a line at the top of two of them
   * overflows the representable range on its own. That is the fourth failure
   * path issueQuoteInputSchema's superRefine answers as a 400; here it is a
   * total that reads as unavailable rather than a form that disappears.
   */
  it("returns null rather than throwing when the arithmetic cannot be represented", () => {
    const huge = line({ qty: "2147483.647", unitPrice: "90071992547409.91", taxRate: "0" });
    expect(() => documentTotals([
      { qtyMilli: 2_147_483_647, unitPriceCents: Number.MAX_SAFE_INTEGER, taxRateBp: 0 },
    ])).toThrow();
    expect(runningTotals([huge])).toBeNull();
  });
});

describe("contentBudget", () => {
  it("reports what is left of the budget the server gates on", () => {
    const state = contentBudget(draft());
    expect(state.budget).toBe(DOCUMENT_CONTENT_BUDGET_BYTES);
    expect(state.remaining).toBe(state.budget - state.used);
    expect(state.over).toBe(false);
    expect(state.used).toBeGreaterThan(0);
  });

  /**
   * The budget counts ESCAPED bytes, not characters: `&` costs five because
   * substitution escapes it and the sanitiser leaves it escaped. A form
   * counting string length would tell somebody they had room they do not have.
   */
  it("charges an ampersand five bytes and a plain letter one", () => {
    const plain = contentBudget(draft({ notes: "aaaaa" })).used;
    const amps = contentBudget(draft({ notes: "&&&&&" })).used;
    expect(amps - plain).toBe(20);
  });

  /**
   * THE PER-FIELD CAPS CANNOT EXPRESS THIS, WHICH IS THE WHOLE REASON THE
   * BUDGET EXISTS. Sixty lines of 250 ASCII characters with every optional
   * field maxed is about 38KB and fits comfortably; the SAME quote written in
   * ampersands is 86KB, because each one escapes to five bytes. A form that
   * counted characters would call the second one legal.
   */
  it("goes over, and says by how much, once the content passes the budget", () => {
    const ascii = maxedDraft("x");
    expect(contentBudget(ascii).over).toBe(false);

    const state = contentBudget(maxedDraft("&"));
    expect(state.over).toBe(true);
    expect(state.remaining).toBeLessThan(0);
    expect(state.used).toBeGreaterThan(contentBudget(ascii).used);
  });
});

describe("buildIssueQuoteInput", () => {
  it("converts a filled form into the API's own input shape", () => {
    const result = buildIssueQuoteInput(draft({
      validUntilDate: "2026-09-30",
      recipientContactName: "Jane Smith",
      lines: [line({ qty: "1.5", unitPrice: "1250.00", taxRate: "21" })],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.lines).toEqual([
      { description: "Consultancy", qtyMilli: 1500, unitPriceCents: 125_000, taxRateBp: 2100 },
    ]);
    expect(result.input.issueDate).toBe("2026-08-29");
    expect(result.input.validUntilDate).toBe("2026-09-30");
  });

  it("sends no valid-until date rather than an empty string when the field is blank", () => {
    const result = buildIssueQuoteInput(draft({ validUntilDate: "" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.validUntilDate).toBeNull();
  });

  it("refuses each half-typed state with a sentence naming the line and the field", () => {
    for (const partial of ["", ".", "-", "1e5", "1.2345"]) {
      const result = buildIssueQuoteInput(draft({
        lines: [line({ id: "a" }), line({ id: "b", qty: partial })],
      }));
      expect(result.ok, partial).toBe(false);
      if (result.ok) continue;
      expect(result.problems.join(" "), partial).toContain("Line 2");
      expect(result.problems.join(" "), partial).toContain("quantity");
    }
  });

  it("requires a description on every line", () => {
    const result = buildIssueQuoteInput(draft({ lines: [line({ description: "   " })] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("description");
  });

  /**
   * The per-field parse reports first and returns without running the schema,
   * so somebody who typed `1e5` reads one sentence about that box rather than
   * that sentence plus a complaint about a total computed from the zero that
   * replaced it.
   */
  it("reports the field before the schema, not both at once", () => {
    const result = buildIssueQuoteInput(draft({ recipientName: "", lines: [line({ qty: "" })] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("quantity");
  });

  /**
   * The bounds are NOT restated here: the same schema the route and the
   * service parse decides, so the only way this form and the server can
   * disagree about what a valid quote is is a stale build of the package.
   */
  it("defers to issueQuoteInputSchema once every field parses", () => {
    const long = "x".repeat(DOCUMENT_MAX_DESCRIPTION_CHARS + 1);
    const tooLong = buildIssueQuoteInput(draft({ lines: [line({ description: long })] }));
    expect(tooLong.ok).toBe(false);

    const lines = Array.from({ length: DOCUMENT_MAX_LINES + 1 }, (_, i) => line({ id: `l${String(i)}` }));
    expect(buildIssueQuoteInput(draft({ lines })).ok).toBe(false);
    expect(buildIssueQuoteInput(draft({ lines: lines.slice(0, DOCUMENT_MAX_LINES) })).ok).toBe(true);

    expect(buildIssueQuoteInput(draft({ recipientName: "" })).ok).toBe(false);
    // Postgres has no year zero, and z.iso.date() accepts one: that quote
    // rendered a PDF before dying on the INSERT until the schema floored it.
    expect(buildIssueQuoteInput(draft({ issueDate: "0000-01-01" })).ok).toBe(false);
    // A NUL is legal JSON, passes every length bound, and a `text` column
    // cannot hold it: before Task 4's review that quote rendered a PDF and
    // then failed the INSERT with a 22021.
    expect(buildIssueQuoteInput(draft({ notes: "a\u0000b" })).ok).toBe(false);
  });

  it("refuses a quote over the content budget with the server's own message", () => {
    expect(buildIssueQuoteInput(maxedDraft("x")).ok).toBe(true);
    const result = buildIssueQuoteInput(maxedDraft("&"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("bytes");
  });

  it("refuses the arithmetic the running total shows as unavailable", () => {
    const huge = line({ qty: "2147483.647", unitPrice: "90071992547409.91" });
    expect(runningTotals([huge])).toBeNull();
    expect(buildIssueQuoteInput(draft({ lines: [huge] })).ok).toBe(false);
  });
});
