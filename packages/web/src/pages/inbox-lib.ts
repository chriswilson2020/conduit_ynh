/**
 * The inbox's phone drill-in stack, as a pure function of what the page
 * already knows.
 *
 * WHY A MODULE RATHER THAN THREE TERNARIES IN THE PAGE. Below the breakpoint
 * the inbox becomes three screens visited one at a time, and "which screen am
 * I on, what is it called, and how do I leave it" is the whole of that
 * behaviour.
 *
 * BE PRECISE ABOUT WHAT CHANGES AND WHERE, because there are two different
 * widths in play and an earlier draft of this paragraph ran them together. The
 * grid's three COLUMNS are `lg:`-gated, so the panes have stacked into one
 * column below 1024px since long before this phase -- that is CSS and it is
 * not ours. What this module adds happens below the 768px breakpoint, and it
 * is narrower than "the grid stops being three panes": all three were already
 * stacked and all three were on screen at once, and the stack shows exactly
 * one of them at a time. Between 768 and 1024 the page is what it always was:
 * stacked, and all three visible. Kept here it is testable without a DOM --
 * this repo has no testing-library, so a rule that lives in JSX is a rule only
 * an e2e run can check -- and the phase's hard requirement (the DESKTOP must
 * not change) becomes an assertion rather than a hope: `inboxStackView` with
 * `isMobile: false` returns DESKTOP_VIEW for every other input, and a test
 * pins that.
 *
 * THIS MODULE OWNS NO STATE. It is handed the two facts the page holds -- the
 * `?thread=` search param and whether the folder screen has been asked for --
 * and returns what to render. The selection in particular stays in the URL,
 * where it was before this phase (a conversation is linkable from the global
 * search and from every record page's Mail tab), so the stack reads it rather
 * than shadowing it.
 */

/**
 * The three screens, which are also the three panes of the desktop grid: the
 * phone stack shows exactly one of the same panes at a time rather than
 * rendering a second set of components.
 */
export const INBOX_LEVELS = ["folders", "threads", "conversation"] as const;
export type InboxLevel = (typeof INBOX_LEVELS)[number];

/**
 * What the control at the start of the page heading does.
 *
 * "back" always returns to the thread list, from either neighbour;
 * "open-folders" is the one control that moves the other way. The thread list
 * is the HUB, not the root of a strict line: it is where the Mail tab lands
 * (an inbox that opened on a folder list would cost every visit a tap), and
 * both of its neighbours are one control away from it in each direction.
 *
 * WHAT MAKES "no surface is a dead end" TRUE HERE is that every level has a
 * way BACK -- not that every level has a leading control, which an earlier
 * version of this comment said and which is not the distinction: the hub has
 * a leading control too, it just points forward rather than back. The hub
 * needs no way back because it is the screen the bottom navigation itself
 * always reaches, and it is the only level that can be without one.
 */
export type InboxLeadingKind = "back" | "open-folders";

export interface InboxLeading {
  readonly kind: InboxLeadingKind;
  /** Visible text; a phone header has room for a word and it beats a bare glyph. */
  readonly label: string;
}

export interface InboxStackInput {
  /** Below the breakpoint. The page reads it from useIsMobile(). */
  readonly isMobile: boolean;
  /** The `?thread=` search param, null when absent. */
  readonly threadId: string | null;
  /** Whether the folder screen has been asked for (page state; see the page). */
  readonly foldersOpen: boolean;
  /**
   * Whether there is a folder rail to show at all.
   *
   * FolderSidebar renders nothing for a user with no own, non-archived mail
   * account, so on such an install the folder screen would be a blank page
   * with a Back button -- an empty room the phase's definition of done would
   * rightly count against this surface. With no rail the threads level simply
   * has no way in, which is also the honest answer: there are no folders.
   */
  readonly hasFolderRail: boolean;
}

export interface InboxStackView {
  /** null ABOVE the breakpoint, where there is no stack: the grid shows all three. */
  readonly level: InboxLevel | null;
  /** The page's h1. */
  readonly title: string;
  readonly leading: InboxLeading | null;
  /** Which of the grid's three panes are on screen. */
  readonly panes: Readonly<Record<InboxLevel, boolean>>;
}

/**
 * Every pane at once -- the desktop grid, and the only shape that existed
 * before this phase.
 *
 * FROZEN, not merely `readonly`. This object and the view below are handed to
 * every desktop caller rather than rebuilt per call, so a write through either
 * is not one component's mistake -- it is every subsequent desktop render.
 * `readonly` stops the innocent path and stops nothing else: one cast, and
 * `panes.conversation = false` drops a pane from the desktop grid for the rest
 * of the session, which is the exact outcome this module exists to make
 * impossible. Freezing turns that into a TypeError (these are ES modules, so
 * strict mode). Proportionate here and nowhere else in this file: this is the
 * constant whose whole job is being the phase's hard requirement expressed as
 * a value.
 */
const ALL_PANES: Readonly<Record<InboxLevel, boolean>> = Object.freeze({
  folders: true, threads: true, conversation: true,
});

/**
 * The app as it was: all three panes, the heading the page has always had, and
 * no control that did not exist before. Returned for EVERY input above the
 * breakpoint, which is the phase's hard requirement expressed as a value.
 */
const DESKTOP_VIEW: InboxStackView = Object.freeze({
  level: null, title: "Inbox", leading: null, panes: ALL_PANES,
});

/**
 * Each level's heading and its way out.
 *
 * The threads level's title is deliberately the SAME string as the desktop
 * heading: a phone landing on the inbox should not be told it is somewhere
 * else, and a test pins the two together so a future rename cannot separate
 * them.
 */
const LEVEL_CHROME: Readonly<Record<InboxLevel, { title: string; leading: InboxLeading }>> = {
  folders: { title: "Folders", leading: { kind: "back", label: "Back" } },
  threads: { title: "Inbox", leading: { kind: "open-folders", label: "Folders" } },
  conversation: { title: "Conversation", leading: { kind: "back", label: "Back" } },
};

/**
 * What the inbox shows, at either width.
 *
 * THE ORDER OF THE TWO TESTS BELOW IS THE INTERESTING PART. A selected thread
 * beats an open folder screen, because the only way to have both is to arrive
 * from somewhere else -- the global search's mail group and every record
 * page's Mail tab navigate to `/mail?thread=<id>` -- and a deep link that
 * landed on a folder list instead of the conversation it named would be a
 * broken link. The page's Back then clears BOTH, so leaving that conversation
 * lands on the thread list rather than on a folder screen the user never
 * opened.
 */
export function inboxStackView(input: InboxStackInput): InboxStackView {
  if (!input.isMobile) return DESKTOP_VIEW;

  const level: InboxLevel = input.threadId !== null
    ? "conversation"
    : input.foldersOpen && input.hasFolderRail ? "folders" : "threads";

  const chrome = LEVEL_CHROME[level];
  return {
    level,
    title: chrome.title,
    // The one level that can lose its control: with no rail to open there is
    // nowhere for the hub's "Folders" to go.
    leading: chrome.leading.kind === "open-folders" && !input.hasFolderRail ? null : chrome.leading,
    panes: {
      folders: level === "folders",
      threads: level === "threads",
      conversation: level === "conversation",
    },
  };
}
