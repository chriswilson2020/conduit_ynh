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

/**
 * Compact "how long ago" label for an ISO timestamp, for places where the
 * exact clock time is noise and the age is the point (Phase 4's mail settings
 * "last synced" line, and the thread list's own timestamps in Task 10).
 *
 * `now` is a parameter, defaulted rather than read from the clock inside, so
 * the behaviour is testable without faking time -- the same reason
 * todayLocalIso below is the only clock reader in this module.
 *
 * Anything older than a week falls back to a plain locale date: past that
 * point "23d ago" is harder to place than the date itself. A timestamp in the
 * future (a clock skew between the server and this browser, not a real event)
 * reads as "just now" rather than a negative age. An unparseable value
 * returns the em-dash placeholder the rest of the UI uses for "nothing to
 * show", never "NaN" or "Invalid Date".
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const thenMs = then.getTime();
  if (Number.isNaN(thenMs)) return "\u2014";
  const seconds = Math.floor((now.getTime() - thenMs) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString();
}

/**
 * Byte count as something a person reads, for file and attachment chips.
 *
 * Lives here rather than in one of the two components that render such a chip
 * (the record Files rail and the conversation's mail attachments): it was
 * written twice, identically, the second time Phase 4 needed it.
 *
 * Binary units under decimal names, matching what the rest of this app's UI
 * has always shown -- 1 KB is 1024 bytes here.
 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Today as a YYYY-MM-DD string in the USER'S LOCAL calendar, not UTC.
 * toISOString() is always UTC, which misclassifies "due today" around local
 * midnight for any non-UTC timezone. Date-only strings in this app mean the
 * user's calendar day, so "today" must too. */
export function todayLocalIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
