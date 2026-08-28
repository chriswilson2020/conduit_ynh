/**
 * The deals board's phone stage view, plus the two board rules both widths
 * share once the phone stops rendering columns.
 *
 * WHY A MODULE RATHER THAN TERNARIES IN THE PAGE. Below the breakpoint the
 * kanban is not a re-laid-out kanban: a column is a horizontal thing, and there
 * is room for one. So the phone shows a stage picker, that stage's deals as a
 * list, and a "Move to..." action per card -- and "which stage am I looking at,
 * what can I offer as a picker, and where can this deal go" is the whole of
 * that behaviour. Kept here it is testable without a DOM (this repo has no
 * testing-library, so a rule that lives in JSX is a rule only an e2e run can
 * check), and the phase's hard requirement -- the DESKTOP must not change --
 * becomes an assertion rather than a hope: `boardStageView` with
 * `isMobile: false` returns DESKTOP_VIEW for every other input, and a test pins
 * that over the FULL cross-product of the other three -- all eighteen cases,
 * generated rather than listed, because a hand-picked list described as a
 * cross-product is a sample dressed as a proof.
 *
 * WHAT `null` MEANS IN THIS MODULE, because the page's whole branch hangs off
 * it: `view.stage === null` is "there is no stage view here", which is every
 * input above the breakpoint and the one input below it that has no stage to
 * show. The page reads it as "render the board you always rendered". That is
 * also what TIES THE SEAM the inbox had to guard with a source reader: the
 * stage view component takes a non-null stage, so inverting the branch is a
 * type error rather than a phone bug nothing catches.
 *
 * THIS MODULE OWNS NO STATE. It is handed the pipeline's stages, which stage
 * the page has been asked for, and whether the pipeline is archived.
 *
 * ON RETURN-VALUE IDENTITY, which matters more here than in the inbox's
 * equivalent: `picker` is the caller's OWN array, returned by reference rather
 * than copied, and `moveTargets` is one array for the whole list because every
 * card in the list is in the same stage. The page memoises the view. Building a
 * move-target array per card would hand every card a fresh prop on every
 * render.
 *
 * The two functions at the bottom are not about the phone at all. They are
 * board rules -- what a stage's value line says, and when a deal has gone stale
 * -- that were written once inside the desktop column and now have a second
 * caller in the stage view. Extracting them is what stops the phone growing its
 * own slightly-different copy of either.
 */

/**
 * The part of a Stage this module reads. Structural, and every function below
 * is generic over it, so the tests can pass plain objects while the page passes
 * real `Stage`s and gets real `Stage`s back -- which is what lets the stage
 * view hand `view.stage` straight to the column header component.
 */
export interface StageLike {
  readonly id: string;
  readonly name: string;
}

/** The part of a Deal the value line reads. */
export interface DealValueLike {
  readonly valueCents: number | null;
  readonly currency: string;
}

export interface BoardStageViewInput<T extends StageLike> {
  /** Below the breakpoint. The page reads it from useIsMobile(). */
  readonly isMobile: boolean;
  /** The pipeline's stages, in pipeline order. */
  readonly stages: readonly T[];
  /** Which stage the picker has been asked for; null before anything is picked. */
  readonly chosenStageId: string | null;
  /** An archived pipeline's board is read-only, deal moves included. */
  readonly archived: boolean;
}

export interface BoardStageView<T extends StageLike> {
  /** The stage on screen -- null ABOVE the breakpoint, where the board shows every column. */
  readonly stage: T | null;
  /** What the picker offers; empty above the breakpoint. */
  readonly picker: readonly T[];
  /** Where a card in `stage` can go; empty above the breakpoint and on an archived pipeline. */
  readonly moveTargets: readonly T[];
}

/**
 * FROZEN, not merely `readonly`, and shared rather than rebuilt per call.
 *
 * `readonly` stops the innocent path and stops nothing else: one cast, and
 * `(view as { stage: Stage }).stage = someStage` puts a phone stage view in
 * front of every subsequent DESKTOP render for the rest of the session, which
 * is the exact outcome this module exists to make impossible. Freezing turns
 * that into a TypeError (these are ES modules, so strict mode). Proportionate
 * for the one constant whose whole job is being the phase's hard requirement
 * expressed as a value, and applied nowhere else in this file.
 */
const NO_STAGES: readonly never[] = Object.freeze([]);

const DESKTOP_VIEW: BoardStageView<never> = Object.freeze({
  stage: null,
  picker: NO_STAGES,
  moveTargets: NO_STAGES,
});

/**
 * Where a deal sitting in `fromStageId` can be moved.
 *
 * The current stage is excluded -- a "Move to..." list offering the stage the
 * card is already in is an action that does nothing -- and the order is the
 * pipeline's own, because that order is the pipeline's meaning and a phone
 * offering the stages in some other sequence would be describing a different
 * board from the one the desk shows.
 *
 * An archived pipeline offers NONE. Its board is read-only at a desk (the drag
 * sensors are disabled, `services/deals.ts` refuses the move anyway), so a
 * phone that offered the action would be offering a button that 403s.
 */
export function stageMoveTargets<T extends StageLike>(
  stages: readonly T[],
  fromStageId: string,
  archived: boolean,
): readonly T[] {
  if (archived) return NO_STAGES;
  return stages.filter((stage) => stage.id !== fromStageId);
}

/**
 * What the board shows, at either width.
 *
 * THE FALLBACK IS THE INTERESTING PART. The chosen stage is component state --
 * see the page for why it is not in the URL -- so it can name a stage that is
 * no longer there: a stage deleted or renamed away in another tab, or simply
 * the null the page starts with before anything has been picked. Rather than
 * making the page defend against that, an unresolvable choice falls back to the
 * FIRST stage, which is the pipeline's own entry point and the stage a board
 * opens on. Only a pipeline with no stages at all yields no stage view; there
 * is nothing to show and the board's own empty state (an "+ Stage" tile and
 * nothing else) is the honest screen.
 */
export function boardStageView<T extends StageLike>(input: BoardStageViewInput<T>): BoardStageView<T> {
  if (!input.isMobile) return DESKTOP_VIEW;

  const stage = input.stages.find((candidate) => candidate.id === input.chosenStageId) ?? input.stages[0] ?? null;
  return {
    stage,
    picker: input.stages,
    moveTargets: stage === null ? NO_STAGES : stageMoveTargets(input.stages, stage.id, input.archived),
  };
}

/**
 * A stage's value line, as the column header has shown it since Phase 2 and as
 * the phone's stage header now shows it too.
 *
 * A single Conduit instance has one DEFAULT_CURRENCY (see the Phase 2 design's
 * currency decision), so a mixed-currency stage is unreachable through the
 * board's own "New deal" dialog -- but updateDeal's currency field is directly
 * PATCHable via the API regardless, and a future per-deal currency picker would
 * make it reachable through the UI too. Summing raw cents across currencies
 * would silently misreport the total (100 EUR + 100 USD is not "200"), so this
 * falls back to a literal "mixed" label instead of a wrong number.
 */
export function stageValueLabel(deals: readonly DealValueLike[]): string {
  const currencies = new Set(deals.map((deal) => deal.currency));
  if (currencies.size > 1) return "mixed";
  const valueSum = deals.reduce((sum, deal) => sum + (deal.valueCents ?? 0), 0);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: deals[0]?.currency ?? "EUR",
  }).format(valueSum / 100);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DealRot {
  readonly rotten: boolean;
  /** Only meaningful when `rotten`; the card renders it as the dot's tooltip. */
  readonly title: string;
}

/**
 * Whether a deal has gone stale in its stage, and what the marker says.
 *
 * `>` and not `>=`: a stage that rots after 7 days is not rotten ON day 7. That
 * boundary is the one thing a reader might reasonably assume the other way
 * about, so it is pinned by a test rather than left to the reader.
 *
 * `now` is a parameter rather than a `Date.now()` inside, so the rule is
 * testable without a clock. Both callers pass `Date.now()`.
 */
export function dealRot(updatedAt: string, rotDays: number | null, now: number): DealRot {
  const daysSinceUpdate = Math.floor((now - new Date(updatedAt).getTime()) / MS_PER_DAY);
  return {
    rotten: rotDays !== null && daysSinceUpdate > rotDays,
    title: `No activity for ${daysSinceUpdate} days (stage rots after ${rotDays} days)`,
  };
}
