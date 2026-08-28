import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { withoutComments } from "../test/source";
import {
  boardStageView, dealRot, stageMoveTargets, stageValueLabel,
  type BoardStageViewInput, type StageLike,
} from "./board-lib";

const LEAD: StageLike = { id: "lead", name: "Lead" };
const QUALIFIED: StageLike = { id: "qualified", name: "Qualified" };
const WON: StageLike = { id: "won", name: "Won" };
const STAGES: readonly StageLike[] = [LEAD, QUALIFIED, WON];

/** The inputs that are not the one under test, so each case says only what it
 * is about. */
const PHONE: BoardStageViewInput<StageLike> = {
  isMobile: true, stages: STAGES, chosenStageId: null, archived: false,
};

type Pipeline = Omit<BoardStageViewInput<StageLike>, "isMobile">;

/**
 * Every shape of the three inputs the view reads. The pipeline shapes are the
 * three that behave differently -- several stages, exactly one (nowhere to
 * move), and none at all (nothing to show).
 */
const BASE: Pipeline = { stages: STAGES, chosenStageId: null, archived: false };

const COMBINATIONS: readonly Pipeline[] = [
  BASE,
  { stages: STAGES, chosenStageId: "qualified", archived: false },
  { stages: STAGES, chosenStageId: "gone", archived: false },
  { stages: STAGES, chosenStageId: "qualified", archived: true },
  { stages: [LEAD], chosenStageId: null, archived: false },
  { stages: [LEAD], chosenStageId: "lead", archived: true },
  { stages: [], chosenStageId: null, archived: false },
  { stages: [], chosenStageId: "lead", archived: true },
];

describe("boardStageView above the breakpoint", () => {
  /**
   * THE PHASE'S HARD REQUIREMENT, as an assertion rather than a hope: the
   * desktop must not change, and this is the one function that could change it.
   * `stage === null` is what sends the page down the branch it has always
   * taken, so no input may reach a branch that produces a stage view.
   *
   * Asserted by IDENTITY, not by shape: every desktop call returns the one
   * shared frozen object, so a future edit that builds a per-call desktop view
   * fails here even if it happens to build an equal one -- and it is that
   * sharing the freeze test below depends on.
   */
  it("returns the unchanged board for every input", () => {
    const first = boardStageView({ isMobile: false, ...BASE });
    for (const combination of COMBINATIONS) {
      const view = boardStageView({ isMobile: false, ...combination });
      expect(view).toBe(first);
      expect(view.stage).toBeNull();
      expect(view.picker).toEqual([]);
      expect(view.moveTargets).toEqual([]);
    }
  });

  /**
   * The desktop view is ONE shared object handed to every caller, so a write
   * through it is not a local mistake -- it changes what every subsequent
   * desktop render gets. `readonly` stops the innocent path and nothing else:
   * one cast, and a phone stage view stands in front of the desktop board for
   * the rest of the session. Frozen, that assignment throws.
   */
  it("hands out a desktop view that cannot be written through", () => {
    const view = boardStageView({ isMobile: false, ...BASE });
    expect(() => {
      (view as { stage: StageLike | null }).stage = LEAD;
    }).toThrow(TypeError);
    expect(() => {
      (view.picker as StageLike[]).push(LEAD);
    }).toThrow(TypeError);
    expect(boardStageView({ isMobile: false, ...BASE, chosenStageId: "won" }).stage).toBeNull();
  });
});

describe("boardStageView below the breakpoint", () => {
  it("opens on the pipeline's first stage before anything is picked", () => {
    expect(boardStageView(PHONE).stage).toBe(LEAD);
  });

  it("shows the stage that was picked", () => {
    expect(boardStageView({ ...PHONE, chosenStageId: "won" }).stage).toBe(WON);
  });

  /**
   * The chosen stage is component state, so it can outlive the stage it names
   * -- a stage deleted or a pipeline switched under it. Falling back to the
   * first stage is what stops that being a blank screen the user cannot get
   * out of without reloading.
   */
  it("falls back to the first stage when the pick names a stage that is gone", () => {
    expect(boardStageView({ ...PHONE, chosenStageId: "gone" }).stage).toBe(LEAD);
  });

  /**
   * Returned by reference rather than copied: the page memoises the view and
   * hands `moveTargets` to every card in the list, so a fresh array per call
   * would be a fresh prop per render for no gain.
   */
  it("offers every stage to the picker, as the pipeline's own list", () => {
    expect(boardStageView(PHONE).picker).toBe(STAGES);
  });

  /** Nothing to show and nothing to pick -- the page falls back to the board's
   * own empty state rather than rendering a stage view with no stage. */
  it("has no stage view for a pipeline with no stages", () => {
    const view = boardStageView({ ...PHONE, stages: [] });
    expect(view.stage).toBeNull();
    expect(view.picker).toEqual([]);
    expect(view.moveTargets).toEqual([]);
  });

  it("offers the other stages as move targets, in the pipeline's order", () => {
    expect(boardStageView({ ...PHONE, chosenStageId: "qualified" }).moveTargets).toEqual([LEAD, WON]);
  });

  it("offers no move target on an archived pipeline", () => {
    expect(boardStageView({ ...PHONE, archived: true }).moveTargets).toEqual([]);
  });

  /**
   * The property the phase's definition of done rests on for this surface: the
   * stage view reaches every stage of the pipeline, so no column becomes
   * desktop-only by being left out of the picker.
   */
  it("reaches every stage across its picks -- no stage is desktop-only", () => {
    const reached = new Set<string>();
    for (const stage of STAGES) {
      const view = boardStageView({ ...PHONE, chosenStageId: stage.id });
      if (view.stage !== null) reached.add(view.stage.id);
    }
    expect([...reached].sort()).toEqual(STAGES.map((stage) => stage.id).sort());
  });
});

describe("stageMoveTargets", () => {
  it("excludes the stage the deal is already in, keeping the rest in order", () => {
    expect(stageMoveTargets(STAGES, "qualified", false)).toEqual([LEAD, WON]);
    expect(stageMoveTargets(STAGES, "lead", false)).toEqual([QUALIFIED, WON]);
  });

  /** An archived board is read-only at a desk (the drag sensors are removed,
   * and services/deals.ts refuses the move regardless), so offering the action
   * on a phone would be offering a button that can only fail. */
  it("offers none for an archived pipeline", () => {
    expect(stageMoveTargets(STAGES, "lead", true)).toEqual([]);
  });

  it("offers nothing to move to in a single-stage pipeline", () => {
    expect(stageMoveTargets([LEAD], "lead", false)).toEqual([]);
  });

  /** Total over an id that is not in the list, rather than assuming its caller
   * has already resolved one: nothing is excluded because nothing matches. */
  it("excludes nothing when the stage is not one of these", () => {
    expect(stageMoveTargets(STAGES, "gone", false)).toEqual([LEAD, QUALIFIED, WON]);
  });
});

describe("stageValueLabel", () => {
  /** Built the same way the function does but independently of it, so this
   * pins the cents-to-units division and the currency style without pinning
   * the machine's locale. */
  const asEur = (units: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(units);

  it("sums a stage's deals, in cents, in its own currency", () => {
    expect(stageValueLabel([
      { valueCents: 1000, currency: "EUR" },
      { valueCents: 2550, currency: "EUR" },
      { valueCents: null, currency: "EUR" },
    ])).toBe(asEur(35.5));
  });

  it("reads an empty stage as zero", () => {
    expect(stageValueLabel([])).toBe(asEur(0));
  });

  /** 100 EUR + 100 USD is not "200". Unreachable through the board's own New
   * deal dialog, reachable through the API's currency field. */
  it("refuses to add two currencies together", () => {
    expect(stageValueLabel([
      { valueCents: 10000, currency: "EUR" },
      { valueCents: 10000, currency: "USD" },
    ])).toBe("mixed");
  });
});

describe("dealRot", () => {
  const NOW = Date.parse("2026-08-27T12:00:00.000Z");
  const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

  it("never rots a stage that has no rot limit", () => {
    expect(dealRot(daysAgo(365), null, NOW).rotten).toBe(false);
  });

  /** The boundary a reader might reasonably assume the other way about: a
   * stage that rots after 7 days is not rotten ON day 7. */
  it("rots the day after the limit, not on it", () => {
    expect(dealRot(daysAgo(7), 7, NOW).rotten).toBe(false);
    expect(dealRot(daysAgo(8), 7, NOW).rotten).toBe(true);
  });

  it("says how long it has been and what the limit was", () => {
    expect(dealRot(daysAgo(8), 7, NOW).title).toBe("No activity for 8 days (stage rots after 7 days)");
  });
});

/**
 * Guards over pages/board.tsx's source, in the house style: they match a
 * SPELLING, not a behaviour, and each says below what it does not catch.
 * Comments are stripped first -- naming a class in prose must not be able to
 * turn an assertion red (ui/ui.test.ts's tripwire, same reason).
 */
describe("the desktop board in pages/board.tsx", () => {
  const code = withoutComments(readFileSync(new URL("./board.tsx", import.meta.url), "utf8"));

  /**
   * The two class strings the desktop board's geometry is: the scrolling row of
   * columns, and a column. The phone's stage view reuses neither, so a tidy-up
   * that "shared" them between the two widths fails here. Says nothing about a
   * class composed with clsx() or a variable, like every source guard in this
   * package.
   */
  it("still carries the desktop board's own frame", () => {
    expect(code).toContain('data-testid="board" className="flex items-start gap-4 overflow-x-auto pb-4"');
    expect(code).toContain('className="flex w-72 shrink-0 flex-col gap-2 rounded-lg bg-slate-100 p-2"');
  });

  /**
   * The phone branch renders no second drag context. One would be worse than
   * useless: dnd-kit's sensors would be live on a surface with no drop targets,
   * and the spec puts touch drag out of scope for this phase entirely.
   */
  it("renders exactly one drag context", () => {
    expect(code.split("<DndContext")).toHaveLength(2);
  });

  /**
   * THE TASK'S EXPLICIT INSTRUCTION: the move goes through the EXISTING deal
   * service path and never a second one, so the optimistic reposition, the
   * rollback, the 409 refetch, the server's compaction and the SSE hint are
   * unchanged. One hook instance, two callers -- the drag and the phone.
   *
   * What it cannot see: a move issued from a component this file merely
   * renders, or a second path added as a new hook in queries.ts. It catches the
   * likely mistake (a phone-shaped copy of the mutation written here) and says
   * nothing about the unlikely one.
   */
  it("moves a deal through the one existing mutation, at both widths", () => {
    expect(code.split("useMoveDeal(")).toHaveLength(2);
    expect(code.match(/moveDeal\.mutate\(/g)).toHaveLength(2);
    expect(code).not.toMatch(/\b(fetch|postJson)\(/);
  });
});
