import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { INBOX_LEVELS, inboxStackView, type InboxLevel, type InboxStackInput } from "./inbox-lib";

/** The inputs that are not the one under test, so each case says only what it
 * is about. */
const PHONE: InboxStackInput = {
  isMobile: true, threadId: null, foldersOpen: false, hasFolderRail: true,
};

/** Every combination of the two inputs the stack reads, for the properties
 * that must hold across all of them. */
const COMBINATIONS: readonly Pick<InboxStackInput, "threadId" | "foldersOpen" | "hasFolderRail">[] = [
  { threadId: null, foldersOpen: false, hasFolderRail: true },
  { threadId: null, foldersOpen: true, hasFolderRail: true },
  { threadId: "t1", foldersOpen: false, hasFolderRail: true },
  { threadId: "t1", foldersOpen: true, hasFolderRail: true },
  { threadId: null, foldersOpen: false, hasFolderRail: false },
  { threadId: null, foldersOpen: true, hasFolderRail: false },
  { threadId: "t1", foldersOpen: false, hasFolderRail: false },
  { threadId: "t1", foldersOpen: true, hasFolderRail: false },
];

describe("inboxStackView above the breakpoint", () => {
  /**
   * THE PHASE'S HARD REQUIREMENT, as an assertion rather than a hope: the
   * desktop must not change, and this is the one function that could change
   * it. No input reaches a branch that alters what the grid renders.
   */
  it("returns the unchanged three-pane grid for every input", () => {
    for (const combination of COMBINATIONS) {
      const view = inboxStackView({ isMobile: false, ...combination });
      expect(view.level).toBeNull();
      expect(view.leading).toBeNull();
      expect(view.title).toBe("Inbox");
      expect(view.panes).toEqual({ folders: true, threads: true, conversation: true });
    }
  });
});

describe("inboxStackView below the breakpoint", () => {
  it("lands on the thread list, with the folder screen one control away", () => {
    const view = inboxStackView(PHONE);
    expect(view.level).toBe("threads");
    expect(view.panes).toEqual({ folders: false, threads: true, conversation: false });
    expect(view.leading).toEqual({ kind: "open-folders", label: "Folders" });
  });

  /** The heading must not change under the reader when a phone opens the same
   * page a desk does. */
  it("calls the thread list what the desktop calls the page", () => {
    expect(inboxStackView(PHONE).title).toBe(inboxStackView({ ...PHONE, isMobile: false }).title);
  });

  it("shows the folder rail alone once it is asked for, with a way back", () => {
    const view = inboxStackView({ ...PHONE, foldersOpen: true });
    expect(view.level).toBe("folders");
    expect(view.title).toBe("Folders");
    expect(view.panes).toEqual({ folders: true, threads: false, conversation: false });
    expect(view.leading).toEqual({ kind: "back", label: "Back" });
  });

  it("shows the conversation alone once a thread is selected, with a way back", () => {
    const view = inboxStackView({ ...PHONE, threadId: "t1" });
    expect(view.level).toBe("conversation");
    expect(view.title).toBe("Conversation");
    expect(view.panes).toEqual({ folders: false, threads: false, conversation: true });
    expect(view.leading).toEqual({ kind: "back", label: "Back" });
  });

  /**
   * The only way to hold both is to arrive from elsewhere -- the global
   * search's mail group and every record page's Mail tab navigate to
   * /mail?thread=<id> -- and a deep link that landed on a folder list instead
   * of the conversation it named would be a broken link.
   */
  it("lets a deep-linked thread beat a folder screen that was left open", () => {
    const view = inboxStackView({ ...PHONE, threadId: "t1", foldersOpen: true });
    expect(view.level).toBe("conversation");
    expect(view.panes.folders).toBe(false);
  });

  /** One screen at a time is the whole point of a drill-in stack. */
  it("shows exactly one pane, whatever it is given", () => {
    for (const combination of COMBINATIONS) {
      const view = inboxStackView({ isMobile: true, ...combination });
      const shown = INBOX_LEVELS.filter((level) => view.panes[level]);
      expect(shown).toHaveLength(1);
      expect(shown[0]).toBe(view.level);
    }
  });

  /**
   * The property the phase's definition of done rests on for this surface,
   * and the counterpart of nav-lib's partition test: every pane of the
   * desktop grid is reachable from some level, so nothing on this page
   * becomes desktop-only by being left out of the stack.
   */
  it("reaches all three panes across its levels -- nothing is desktop-only", () => {
    const reached = new Set<InboxLevel>();
    for (const combination of COMBINATIONS) {
      const view = inboxStackView({ isMobile: true, ...combination });
      for (const level of INBOX_LEVELS) if (view.panes[level]) reached.add(level);
    }
    expect([...reached].sort()).toEqual([...INBOX_LEVELS].sort());
  });

  /**
   * No level is a dead end: the two screens that are not the hub each carry a
   * Back, and the hub is the one screen the bottom navigation itself always
   * reaches.
   */
  it("gives every level that is not the thread list a Back", () => {
    for (const combination of COMBINATIONS) {
      const view = inboxStackView({ isMobile: true, ...combination });
      if (view.level === "threads") continue;
      expect(view.leading).toEqual({ kind: "back", label: "Back" });
    }
  });

  /** An install with no mail account has no rail to show, so the door to it
   * is not offered and cannot be forced. */
  it("offers no folder screen when there is no folder rail", () => {
    const noRail = { ...PHONE, hasFolderRail: false };
    expect(inboxStackView(noRail).leading).toBeNull();
    const forced = inboxStackView({ ...noRail, foldersOpen: true });
    expect(forced.level).toBe("threads");
    expect(forced.panes.threads).toBe(true);
  });
});

/**
 * Guards over pages/inbox.tsx's source, in the house style: they match a
 * SPELLING, not a behaviour, and each one says below what it does not catch.
 * Comments are stripped first -- naming a utility in prose must not be able
 * to turn an absence assertion red (ui/ui.test.ts's tripwire, same reason).
 */
describe("the desktop frame in pages/inbox.tsx", () => {
  const source = readFileSync(new URL("./inbox.tsx", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("still carries the three-column grid the desktop has always had", () => {
    expect(code).toContain("lg:grid-cols-[minmax(0,11rem)_minmax(0,24rem)_minmax(0,1fr)]");
  });

  /**
   * The plan's explicit instruction for this task: the viewport-height cap is
   * a DESKTOP rule and must not be mirrored below the breakpoint, where
   * <main> gives a pane no definite height to scroll within. Catches a second
   * viewport-unit rule; does NOT catch a height expressed some other way
   * (a full-height utility, a flex basis), which is a judgement no regex
   * makes.
   */
  it("gives the phone stack no viewport-height frame of its own", () => {
    expect(code.match(/100[ds]?vh/g)).toHaveLength(1);
    expect(code).toContain("lg:h-[calc(100vh-11rem)]");
  });

  /**
   * The stack shows and hides the panes it already had; it does not render a
   * second phone copy of any of them. Two copies would put two elements
   * behind testids the mail journeys address by name -- the strict-mode
   * violation the shell's own JS branch exists to avoid. Counts JSX element
   * names, so it says nothing about a copy introduced through a wrapper
   * component under another name.
   */
  it("renders each mail pane exactly once", () => {
    for (const pane of ["<FolderSidebar", "<ThreadList", "<Conversation"]) {
      expect(code.split(pane)).toHaveLength(2);
    }
  });
});
