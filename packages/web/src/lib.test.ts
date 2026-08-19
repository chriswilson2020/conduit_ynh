import { describe, it, expect } from "vitest";
import { parseDecimal } from "./lib";

describe("parseDecimal", () => {
  it("parses a plain dot-decimal amount", () => {
    expect(parseDecimal("1234.56")).toBe(1234.56);
  });

  it("normalises a comma decimal separator to a dot", () => {
    expect(parseDecimal("1234,56")).toBe(1234.56);
  });

  it("returns null for an empty (post-trim) string", () => {
    expect(parseDecimal("  ")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseDecimal("abc")).toBeNull();
  });
});
