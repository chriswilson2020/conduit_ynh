import { describe, expect, it } from "vitest";
import { MAX_PASSPHRASE_LENGTH, passphraseProblem } from "./passphrase.js";

/**
 * THE RULE BOTH THE PAGE AND THE ROUTE ASK, so both refusals are one answer.
 * services/backup.ts's validatePassphrase throws whatever this returns, and
 * pages/settings-data-lib.ts prints it under the field.
 */

describe("passphraseProblem", () => {
  it("accepts an ordinary passphrase", () => {
    expect(passphraseProblem("correct horse battery staple")).toBeNull();
  });

  it("refuses an empty one, because a backup is never written unencrypted", () => {
    expect(passphraseProblem("")).toContain("never written unencrypted");
  });

  it("refuses a newline, and says what 7z would do with it", () => {
    // THE ONE THAT MATTERS. Measured by Task 2 on the deploy target: 7z reads
    // one line from stdin, so "abc\ndef" encrypts with "abc" and reports
    // success -- an archive with a passphrase nobody typed and no way back.
    const problem = passphraseProblem("abc\ndef");
    expect(problem).not.toBeNull();
    expect(problem).toContain("line break");
    // The reason, not just the rule: a message that said "invalid character"
    // would tell somebody nothing they could act on.
    expect(problem).toContain("7z reads it up to the first line break");
  });

  it("refuses a carriage return, a tab and a null the same way", () => {
    for (const bad of ["a\rb", "a\tb", "a\u000Bb", "a\u0000b", "a\u001Fb", "a\u007Fb"]) {
      expect(passphraseProblem(bad), JSON.stringify(bad)).toContain("control characters");
    }
  });

  it("allows the printable characters a real passphrase is made of", () => {
    for (const good of [
      " leading and trailing ",
      "M\u00FCller-Stra\u00DFe-2026",
      "a:b:c",
      "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
      "\u00A0non-breaking space",
      "next\u0085line",
    ]) {
      // The last two are deliberate: U+00A0 and U+0085 are in the C1/Latin-1
      // supplement rather than C0, 7z passes them through unharmed, and the
      // rule is "what 7z would silently change" rather than "what looks odd".
      expect(passphraseProblem(good), JSON.stringify(good)).toBeNull();
    }
  });

  it("allows exactly the maximum length and refuses one more", () => {
    expect(passphraseProblem("x".repeat(MAX_PASSPHRASE_LENGTH))).toBeNull();
    expect(passphraseProblem("x".repeat(MAX_PASSPHRASE_LENGTH + 1)))
      .toContain(String(MAX_PASSPHRASE_LENGTH));
  });

  it("checks the characters before the length, so a long one with a newline says why", () => {
    // Ordering matters for the message somebody reads: "too long" would send
    // them to shorten a passphrase whose real problem is unfixable by shortening.
    const problem = passphraseProblem("a\nb".padEnd(MAX_PASSPHRASE_LENGTH + 10, "x"));
    expect(problem).toContain("line break");
  });
});
