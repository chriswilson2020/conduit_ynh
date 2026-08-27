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

/** The two name fields every `GET /api/users` row carries. Structural rather
 * than @conduit/shared's UserSummary so this module keeps its zero imports and
 * so a caller holding only the name pair (the session's `me`) can use it too. */
export interface NamedUser {
  username: string;
  fullName: string | null;
}

/**
 * How this app writes a person's name: their full name when LDAP supplied one,
 * their login otherwise.
 *
 * THE FALLBACK IS A REQUIRED PARAMETER, not a default, and that is the whole
 * point of the function. The rule above was written nine times across the app
 * and the "user not found" half was written three DIFFERENT ways in meetings.tsx
 * alone -- undefined for a label the caller composes, "..." while the users
 * list is still loading, an em-dash for a stored id whose user has gone. Those
 * are three legitimate answers, so the function takes them as an argument; a
 * default is how a fourth gets picked by accident.
 *
 * Sites that always hold a user (a row rendered FROM the users list) pass the
 * empty string: their fallback is unreachable, which is exactly what an empty
 * one says.
 *
 * FIVE SITES DELIBERATELY DO NOT USE THIS, and a sweep that "finishes the job"
 * by routing them through it changes visible text on any deployment where LDAP
 * supplies full names. They render the LOGIN, not the display name, each via
 * `new Map(users.map((u) => [u.id, u.username]))`: the rail's Timeline, Notes
 * and Files tabs, and the Owner column on the companies and contacts list
 * pages. Whether this app should show logins or display names in those places
 * is a real question with a visible answer -- it is recorded as a post-v0.9.1
 * backlog item, not settled here.
 */
export function userLabel<F extends string | undefined>(
  user: NamedUser | null | undefined, fallback: F,
): string | F {
  if (user === null || user === undefined) return fallback;
  return user.fullName ?? user.username;
}

// ---------------------------------------------------------------------------
// Cursor-page accumulation
// ---------------------------------------------------------------------------

/**
 * Every paged list in this app pages by keyset cursor with the cursor in the
 * query key, so every page is its OWN cache entry -- deliberately not an
 * infinite query, matching the house pattern. The accumulation across pages is
 * therefore the component's job, and this is it: a small immutable record of
 * which pages have been loaded for which filter set.
 *
 * Keyed on the filter set (see identityKey) so that changing a filter cannot
 * leave the previous filter's pages on screen -- the merge below silently
 * starts over whenever the key differs, which is what makes "reset on filter
 * change" a property of the data structure rather than an effect somebody has
 * to remember to write.
 *
 * THE CURSORS LIVE IN HERE TOO, with the key that issued them, and that is
 * load-bearing rather than tidy. When the component held the cursor in its own
 * state beside this record, toggling a filter ON and then OFF again brought the
 * old key back -- and with it the old page-two cursor, while the accumulator
 * had been reset by the intervening filter. The list then fetched page two,
 * accumulated only page two, and page ONE silently vanished. A cursor that
 * belongs to a key cannot outlive it: `cursorForKey` below answers "page one"
 * for any key this record is not currently holding, so a returning filter is
 * page one by construction.
 *
 * WRITTEN FOR THE INBOX (Phase 4, in mail-lib), GENERIC SINCE PHASE 5, and
 * moved here in v0.9.1 once the record timeline and the Meetings tab made it
 * three consumers, two of them in rail/ -- the import edge from rail to mail
 * described where the code had been written, not what it is. `T` needs only an
 * `id`, which is what flattenCursorPages dedupes on, and the type parameter is
 * explicit at all three call sites: a default (it used to be
 * MailThreadListItem) makes mail's use look like the only real one.
 */
export interface CursorPages<T extends { id: string }> {
  /** Filter identity these pages belong to. */
  key: string;
  /** The page currently being requested; FIRST_PAGE for page one. */
  cursor: string;
  /** Cursors in load order; the first page's cursor is FIRST_PAGE. */
  order: string[];
  byCursor: Record<string, readonly T[]>;
  /** `nextCursor` from the most recently merged page: what "load more" would
   * ask for, or null when the server said this was the last page. Held here
   * rather than read off the live query so the button survives its own fetch
   * (the new page's cache entry has no data yet). */
  nextCursor: string | null;
}

/** The first page is fetched with no cursor at all; "" stands in for it as a
 * map key, and can never collide with a real cursor (the routes hold those to
 * `.min(1)`). */
export const FIRST_PAGE = "";

export function emptyCursorPages<T extends { id: string }>(key: string): CursorPages<T> {
  return { key, cursor: FIRST_PAGE, order: [], byCursor: {}, nextCursor: null };
}

/**
 * The cursor to fetch for `key`, or undefined for "page one, no cursor".
 *
 * The whole stale-cursor defence, in one function: a cursor is only ever
 * handed back to the key that issued it. Any other key -- a filter just turned
 * on, or one turned back on after being off -- starts at page one.
 */
export function cursorForKey<T extends { id: string }>(state: CursorPages<T>, key: string): string | undefined {
  if (state.key !== key) return undefined;
  return state.cursor === FIRST_PAGE ? undefined : state.cursor;
}

/**
 * Move to the next page: what "load more" does. A no-op for a key this record
 * is not holding, or when the last page said there is nothing after it -- so a
 * double click, or a click racing a filter change, cannot walk past the end or
 * apply one filter's cursor to another's list.
 */
export function advanceCursorPages<T extends { id: string }>(
  state: CursorPages<T>, key: string,
): CursorPages<T> {
  if (state.key !== key || state.nextCursor === null) return state;
  return { ...state, cursor: state.nextCursor };
}

/**
 * A stable string identity for one set of named values. Sorted by key and built
 * only from defined values, so two objects that mean the same thing produce the
 * same string regardless of how they were assembled.
 *
 * Written for filter sets (the pages above, and the inbox's thread selection),
 * and used as well for "which record is this rail showing" -- the same question
 * asked of the same four link ids. One builder rather than two schemes: a
 * hand-rolled `a|b|c|d` beside this one is a second answer to the same
 * question, and the two drift the moment a fifth link appears.
 *
 * INTERNAL AND BUILD-UNSTABLE. Compare it only against another string this
 * same function produced in the same session. Never persist it (localStorage,
 * a URL, a cache key meant to outlive a reload) and never compare it against a
 * key some other builder made: its exact shape is an implementation detail,
 * and it is now the answer to two different questions in three components,
 * which is precisely when someone reaches for it as a durable id.
 */
export function identityKey(values: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(values)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(entries);
}

/**
 * Fold one fetched page into the accumulator.
 *
 * A different `key` discards everything: the pages on screen describe a filter
 * set nobody is looking at any more.
 *
 * A page whose items are the SAME ARRAY as the one already stored, arriving
 * with the same nextCursor, returns the accumulator UNCHANGED, by reference.
 * That matters: this runs from a render effect, and returning a fresh object
 * for an unchanged page would set state on every render forever. React Query
 * hands out a new array whenever a query actually refetches, so a real refetch
 * still replaces its page -- reference equality is exactly the "nothing new
 * arrived" test, not an approximation of one.
 */
export function mergeCursorPage<T extends { id: string }>(
  state: CursorPages<T>,
  key: string,
  cursor: string | undefined,
  items: readonly T[],
  nextCursor: string | null,
): CursorPages<T> {
  const base = state.key === key ? state : emptyCursorPages<T>(key);
  const at = cursor ?? FIRST_PAGE;
  if (base.byCursor[at] === items && base.cursor === at && base.nextCursor === nextCursor) return base;
  return {
    key,
    cursor: at,
    order: base.order.includes(at) ? base.order : [...base.order, at],
    byCursor: { ...base.byCursor, [at]: items },
    nextCursor,
  };
}

/**
 * The accumulated rows, in page order, de-duplicated by id with the FIRST
 * sighting winning. The dedupe is not paranoia: a thread that gets a new
 * message while a later page is on screen is re-ordered to the top of page one
 * by the server's (last_message_at, id) keyset, and would otherwise be
 * rendered twice -- once from the refreshed first page and once from the stale
 * later one. First-wins keeps the fresher copy. Every keyset in this app has
 * the same property (an event or a meeting arriving mid-scroll shifts the same
 * way), which is why this rule generalised along with the type.
 */
export function flattenCursorPages<T extends { id: string }>(state: CursorPages<T>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const cursor of state.order) {
    for (const item of state.byCursor[cursor] ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/**
 * The ONE width at which this app switches between its two interaction
 * models, as a CSS length. Everything that needs to know what "mobile" means
 * reads it from here: the `@theme` block in styles.css binds Tailwind's `md`
 * variant to it (so `md:` utilities and this constant are the same edge), and
 * use-is-mobile.ts builds its matchMedia query from it. use-is-mobile.test.ts
 * pins the two together, so a change to either side that forgets the other
 * fails a test rather than shipping a UI whose CSS and JS disagree about which
 * half of the app the user is in.
 *
 * The value is Tailwind's own `md` default -- 48rem, i.e. 768px at the browser
 * default root size -- and is deliberately spelled in the same unit Tailwind
 * uses rather than in px, so redeclaring it in styles.css changes nothing at
 * all for the 32 breakpoint utilities already in this package.
 *
 * Chosen for where the two interaction models actually belong, which is not
 * simply "phone vs not":
 *
 *  - Every phone in PORTRAIT (430px at the widest current handset) is below
 *    it, which is the case the phone UI is designed for.
 *  - A tablet in portrait (768px) is at or above it and keeps the sidebar,
 *    which it has width for.
 *  - A large phone in LANDSCAPE (844px and up) is above it and also keeps the
 *    sidebar. That is deliberate, not an oversight: in landscape the scarce
 *    axis is HEIGHT (393px on a 14 Pro), and the sidebar spends width while a
 *    bottom tab bar would spend the axis there is none of.
 *
 * `rem` in a media query resolves against the browser's INITIAL font size, not
 * the root element's, and matchMedia evaluates it by the same rule -- so the
 * CSS half and the JS half agree at every user font-size setting, which a px
 * constant paired with rem breakpoints would not.
 */
export const MOBILE_BREAKPOINT = "48rem";
