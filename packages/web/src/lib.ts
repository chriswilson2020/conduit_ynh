/**
 * Parses a decimal amount typed into a plain-text/number input, tolerating a
 * comma decimal separator (e.g. "12,50", common outside en-US locales) by
 * normalising it to a dot before handing off to `Number()`. Returns `null`
 * for anything `Number()` can't make sense of (garbage input, an empty
 * string after trim) rather than `NaN`, so call sites can treat "no valid
 * number" as one clean case instead of also checking `Number.isNaN`.
 */
export function parseDecimal(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isNaN(parsed) ? null : parsed;
}

/** Today as a YYYY-MM-DD string in the USER'S LOCAL calendar, not UTC.
 * toISOString() is always UTC, which misclassifies "due today" around local
 * midnight for any non-UTC timezone. Date-only strings in this app mean the
 * user's calendar day, so "today" must too. */
export function todayLocalIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
