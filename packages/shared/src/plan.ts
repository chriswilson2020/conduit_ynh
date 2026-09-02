/**
 * WHAT A RESTORE OR AN IMPORT IS ABOUT TO DO, AS A VALUE, WRITTEN ONCE FOR
 * BOTH SIDES.
 *
 * Phase 7.7's spine rests on one decision: `inspect` produces a PLAN, the page
 * renders the plan, and `apply` consumes THE SAME plan and may do nothing the
 * plan did not describe. Three consequences follow, and they are the whole
 * reason to pay for the indirection:
 *
 *   - THE PREVIEW CANNOT LIE. It is not a second implementation predicting
 *     what apply will do. It is the object apply is handed.
 *   - APPLY CANNOT SURPRISE. Anything it does that is not here is a bug with
 *     an obvious shape, and services/intake-plan.ts turns most of that shape
 *     into a thrown error rather than a convention.
 *   - EVERY HARD CASE IS ASSERTABLE WITHOUT EXECUTING IT. A corrupted archive,
 *     a backup from a newer Conduit, a 200,000-row CSV: each is a value this
 *     module's shape can hold, and a test can assert it with no database and
 *     no destruction.
 *
 * THE TYPES HERE ARE THE WIRE FORM, AND THAT IS WHY THEY LIVE IN @conduit/shared
 * rather than beside the engine. The page has to render a plan it received over
 * HTTP; the server has to build one. Two declarations that agree today are two
 * that can stop agreeing, and the one a person reads before destroying their
 * data would be the one that drifted -- the same argument passphrase.ts makes
 * for its own rule, and the same one money.ts makes for the running total.
 *
 * THE SERVER-SIDE PLAN IS NOT THIS TYPE, and the difference matters. A server
 * plan's effects also carry an opaque handle to the staged file each one reads
 * (services/intake.ts's StagedMemberRef), which has no meaning off-process and
 * is deliberately absent here. The plan itself NEVER travels: it is held on the
 * server and addressed by `planId`, so what apply consumes is the identical
 * object inspect produced rather than a re-parse of what a client sent back.
 * A plan that made the round trip would have to be re-validated on arrival,
 * and a re-validated plan is a second implementation -- which is the one thing
 * this design exists to avoid.
 */

/** Which of the three pipelines produced this plan. */
export type PlanKind =
  /** A `.7z` backup, replacing everything. The only kind that destroys. */
  | "restore"
  /** Conduit's own `.zip` export, read back exactly. */
  | "import-export"
  /** A foreign CSV, mapped by hand. */
  | "import-csv";

/**
 * What one planned effect is counted in.
 *
 * A CLOSED SET, because the page renders a unit as a word next to a number and
 * an open string would let one half invent "record" while the other says "row".
 */
export type PlanUnit = "row" | "file" | "table" | "schema" | "key" | "migration";

/**
 * ONE THING APPLY WILL DO.
 *
 * THE COUNT IS WHY THIS SCALES, and it is a design decision rather than a
 * convenience. A CSV of 200,000 rows is ONE effect with `count: 200000`, not
 * 200,000 effects. An effect list that grew with the data would make the plan
 * itself the memory problem the import exists to avoid, and would make the
 * preview unrenderable exactly when it matters most.
 *
 * The count is not decoration: services/intake-plan.ts gives each handler a
 * budget equal to it and requires the handler to account for every unit it
 * consumed, so a plan that says 200,000 rows cannot be applied as 200,001.
 *
 * `destroys` IS SEPARATE FROM THE OPERATION NAME on purpose. The page has to
 * be able to render "what will be destroyed" without knowing which operations
 * any half invented, and the restore confirmation has to be able to say
 * "nothing here destroys anything" and be right.
 */
export interface PlanEffectView {
  /**
   * The operation, in the vocabulary of the half that planned it -- e.g.
   * "load-dump", "insert-rows". Not rendered raw; it is what the page keys an
   * icon or a grouping off.
   */
  readonly op: string;
  /** What is acted on, in the operator's words: "companies", "mail.key". */
  readonly subject: string;
  /** How many `unit` this effect covers. Never negative. */
  readonly count: number;
  readonly unit: PlanUnit;
  /** Whether applying this effect destroys data that exists now. */
  readonly destroys: boolean;
  /** One sentence, already written for a person to read. */
  readonly detail: string;
}

/**
 * Something the operator should know that does not stop the work.
 *
 * A FINDING IS NOT A REFUSAL. "This archive carries a member the manifest does
 * not list" is a finding; "this archive is from a newer Conduit" is a refusal.
 * Conflating them is exactly how a restore comes to reject a perfectly good
 * backup, which is the one mistake Phase 7.7's spec names as unacceptable.
 */
export interface PlanFindingView {
  readonly severity: "note" | "warning";
  /** A stable identifier, so a test can assert a finding without matching prose. */
  readonly code: string;
  readonly message: string;
}

/**
 * Why this plan cannot be applied.
 *
 * A REFUSAL IS STILL A PLAN, and that is the point. A corrupt archive, a wrong
 * passphrase and a newer schema all produce a plan object with `effects: []`
 * and this field set -- so the page renders them through the same path as a
 * plan that will run, and a test asserts them as values with nothing written
 * and nothing destroyed.
 */
export interface PlanRefusalView {
  readonly code: string;
  readonly message: string;
}

/** What was uploaded, as the preview reports it back. */
export interface PlanSourceView {
  /** The upload's own name, sanitised to a basename. */
  readonly filename: string;
  /** The uploaded file's size. */
  readonly bytes: number;
  /** SHA-256 of the uploaded bytes, so the operator can identify the file. */
  readonly sha256: string;
  /** Bytes the payload occupies once staged. Equal to `bytes` when nothing is unpacked. */
  readonly stagedBytes: number;
  /** How many members were staged. 1 for a bare CSV. */
  readonly memberCount: number;
}

/**
 * The whole plan, as the page receives it.
 *
 * `planId` IS THE ONLY THING THAT GOES BACK. Apply is addressed by this id and
 * takes no description of the work from the client, because a client that could
 * describe the work could describe different work.
 */
export interface PlanView {
  readonly planId: string;
  readonly kind: PlanKind;
  /** ISO 8601 UTC. */
  readonly createdAt: string;
  /**
   * ISO 8601 UTC. After this the staged files are deleted and the id stops
   * resolving -- the upload is a credential store and it does not sit around
   * waiting for an operator who wandered off.
   */
  readonly expiresAt: string;
  readonly source: PlanSourceView;
  readonly effects: readonly PlanEffectView[];
  readonly findings: readonly PlanFindingView[];
  readonly refusal: PlanRefusalView | null;
}

/**
 * Whether this plan can be applied at all.
 *
 * ONE FUNCTION, BOTH SIDES: the page disables the confirm control on it and
 * services/intake-plan.ts refuses to dispatch on it. A page that offered a
 * button the server would reject is a page that lies about a destructive
 * operation.
 */
export function planIsApplicable(plan: PlanView): boolean {
  return plan.refusal === null && plan.effects.length > 0;
}

/**
 * Every effect that destroys something, in plan order.
 *
 * SEPARATE FROM RENDERING SO THE CONFIRMATION CANNOT DISAGREE WITH THE LIST.
 * The restore confirmation says what is about to be destroyed; it must be
 * reading the same array the table below it renders.
 */
export function destructiveEffects(plan: PlanView): readonly PlanEffectView[] {
  return plan.effects.filter((effect) => effect.destroys);
}

/**
 * How many `unit` this plan touches in total, destructive or not.
 *
 * Exists so a summary line ("14,204 rows will be created") is derived from the
 * effects rather than counted a second time by whoever writes the sentence.
 */
export function plannedTotal(plan: PlanView, unit: PlanUnit): number {
  return plan.effects.reduce(
    (total, effect) => (effect.unit === unit ? total + effect.count : total),
    0,
  );
}
