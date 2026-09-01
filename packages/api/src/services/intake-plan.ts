import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type {
  PlanEffectView, PlanFindingView, PlanKind, PlanRefusalView, PlanSourceView, PlanView,
} from "@conduit/shared";
import { IntakeRefError } from "./intake.js";
import type { IntakeFile, StagedMemberRef, StagedPayload, StagedReader } from "./intake.js";

// THE SHARED SPINE'S LAST TWO STAGES: THE PLAN, AND THE FRAME APPLY RUNS IN.
//
// services/intake.ts landed the upload and unpacked it. What follows is the
// decision this phase rests on, stated in the spec as "THE PLAN IS A VALUE":
// inspect produces a plan, the page renders the plan, and apply consumes THE
// SAME plan and may do nothing the plan did not describe.
//
// "MAY DO NOTHING THE PLAN DID NOT DESCRIBE" IS THE PART THAT HAS TO BE
// MECHANISM RATHER THAN INTENT, because a property held by convention is a
// property that erodes at the first inconvenient Tuesday. Four mechanisms hold
// it, and each throws rather than warns:
//
//   1. APPLY IS NOT A FUNCTION. It is a MAP FROM OPERATION TO HANDLER, and the
//      executor below is the only thing that calls those handlers -- once per
//      effect the plan lists, in plan order. There is no entry point that runs
//      without an effect in hand, so "something apply did that the plan did not
//      list" has no way to be expressed.
//   2. A HANDLER READS ONLY ITS OWN EFFECT'S SOURCES. The context carries no
//      path, no directory, no member list and no lookup by name -- only refs
//      the effect itself published, resolved through services/intake.ts's
//      per-payload Map. A ref belonging to another effect is refused, a ref
//      from another intake is refused, and a ref that was cast into the type
//      is refused because it was never minted.
//   3. A HANDLER ACCOUNTS FOR WHAT IT DID, against the count the plan published.
//      This is what makes the preview honest about QUANTITY -- 200,000 rows is
//      one effect with a count, and it cannot be applied as 200,001, nor as
//      199,999 without the mismatch being thrown.
//
//      IT BINDS QUANTITY AND NEVER IDENTITY, and that is said plainly rather
//      than left to be inferred. An effect declaring "3 companies created" is
//      satisfied by a handler that DELETES THREE DEALS and spends 3 -- measured,
//      not theorised. The count says how much; nothing here says what. Mechanism
//      2 is the only thing that constrains what a step touches, and it
//      constrains reads, not writes.
//   4. A REFUSAL PLAN CANNOT BE DISPATCHED AT ALL. A corrupt archive and a
//      newer schema produce plans, not exceptions, and those plans are inert.
//   5. THE PLAN IS FROZEN AND ITS EFFECTS ARE COPIES. `readonly` is compile-time
//      only, and until newPlan froze them a caller who kept the array it passed
//      in could push onto it after the page had rendered the preview: one
//      harmless row previewed, "DROP EVERYTHING" applied. See newPlan.
//
// WHAT IS NOT ENFORCED, SAID HERE RATHER THAN LEFT TO BE FOUND. TypeScript has
// no capability-safe module system: a handler that imported `node:fs` could
// read anything this process can read, and no type would stop it. Two things
// keep that a decision rather than an accident. The staging directory is a
// mkdtemp name that appears nowhere apply can see, so reaching it means walking
// $data_dir hunting for it. And mechanism 3 turns the ORDINARY form of the bug
// -- a step that does work nobody wrote down -- into a thrown error, which is
// the form that actually happens.
//
// TWO THINGS THE NEXT TASK SHOULD KNOW BEFORE IT BUILDS ON THIS, because both
// were found while proving the three shapes fit and neither is obvious from the
// types:
//
//   A PLAN IS A SNAPSHOT, NOT A LEASE. What it guarantees is that apply does
//   what the plan says -- not that the plan is still true of the database. The
//   value itself is frozen, so it cannot change; the world it was measured
//   against can. An
//   inspect that counted rows, or checked a CSV row against existing records
//   for duplicates, read a database that can change before apply runs. For
//   restore that is harmless: the row counts are there so an operator sees what
//   they are replacing. For the CSV importer's duplicate detection it is a real
//   semantic, and the importer has to decide whether a row that became a
//   duplicate in the meantime is inserted anyway. IntakeSessionStore's TTL is
//   what bounds the window; it does not close it.
//
//   TWO EFFECTS CAN BE ONE ATOMIC ACT. Restore has to drop the schema and load
//   the dump inside ONE psql transaction, but the operator has to SEE those as
//   two things -- what is destroyed, and what replaces it. The mechanism is the
//   carrier: the destroy step leaves its SQL preamble on it and the load step
//   runs psql over both, so the atomicity lives inside the child process where
//   it belongs. But the VOCABULARY had to grow, and `realisedBy` is it -- three
//   things follow from a preparatory effect that the carrier alone does not
//   answer, all of them cheaper now than after restore is written on top:
//
//     - its accounting is vacuous. `spent === count` is satisfied before the
//       work is attempted, so the one effect marked `destroys: true` that
//       matters most is the one whose accounting means nothing;
//     - the outcome would be wrong on failure. Anything reading `dispatched`
//       after a mid-plan throw would report the destroy as having happened when
//       the transaction rolled it back -- reporting inside the blast radius the
//       spec calls the worst outcome this app can produce;
//     - nothing paired a preparation with its consumer, so a preamble could sit
//       unused while the plan reported success.
//
//   The field answers all three: the executor refuses a plan whose preparation
//   has no later consumer, and ApplyOutcome separates `dispatched` from
//   `realised`.

/**
 * ONE THING APPLY WILL DO, server-side.
 *
 * The wire form (@conduit/shared's PlanEffectView) plus the refs this effect is
 * allowed to read. The refs are the only field that does not travel: they are
 * object identities with no meaning outside this process, which is also why the
 * plan itself never leaves it.
 */
export interface PlannedEffect extends PlanEffectView {
  /**
   * Every staged member this effect may read. Usually one; a "write the blobs"
   * effect names all of them and carries their number in `count`.
   *
   * ABSENT MEANS READS NOTHING, and the executor enforces exactly that: an
   * effect with no sources gets a context whose `open` refuses every ref.
   */
  readonly sources?: readonly StagedMemberRef[];
  /**
   * The `op` of the LATER effect that realises this one, when this effect only
   * PREPARES work rather than doing it.
   *
   * THIS EXISTS BECAUSE A PREPARATORY EFFECT'S ACCOUNTING IS VACUOUS, and the
   * case that needs it is the most dangerous one in the product. Restore must
   * drop the schema and load the dump inside ONE psql transaction, so the
   * destroy step can only leave its SQL preamble on the carrier for the load
   * step to run. It therefore satisfies `spent === count` BEFORE anything has
   * been destroyed -- the one effect marked `destroys: true` that matters most
   * is the one whose accounting means nothing, and without this field nothing
   * in the types would tell a reviewer which `spend` calls are real.
   *
   * Naming the consumer buys two things the executor enforces. A plan whose
   * preparation has no later consumer is REFUSED before anything dispatches, so
   * a preamble cannot be left sitting unused while the plan reports success.
   * And ApplyOutcome can separate DISPATCHED from REALISED, so a failure part
   * way through does not report a destruction that the transaction rolled back
   * -- reporting inside the silent-half-restore blast radius is the worst thing
   * this frame could get wrong.
   */
  readonly realisedBy?: string;
}

/**
 * WHAT A RESTORE OR AN IMPORT IS ABOUT TO DO.
 *
 * Generic over the effect union so each half owns its own operations while the
 * frame stays one frame. The type parameter is what makes the handler map below
 * EXHAUSTIVE: a half that adds an operation and forgets to handle it does not
 * compile, and a handler for an operation no effect can carry does not compile
 * either.
 */
export interface Plan<E extends PlannedEffect = PlannedEffect> {
  readonly id: string;
  readonly kind: PlanKind;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly source: PlanSourceView;
  readonly effects: readonly E[];
  readonly findings: readonly PlanFindingView[];
  readonly refusal: PlanRefusalView | null;
}

/** The plan cannot be applied: it is a refusal, or it describes nothing to do. */
export class PlanRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PlanRefusedError";
  }
}

/**
 * APPLY TRIED TO DO SOMETHING ITS PLAN DID NOT DESCRIBE.
 *
 * Every instance of this is a bug in a handler, and the message names which of
 * the mechanisms above caught it. It is deliberately not recoverable: the
 * executor throws it out through whatever transaction the carrier represents,
 * so the half's own rollback is what the operator ends up with.
 */
export class PlanExceededError extends Error {
  constructor(readonly op: string, message: string) {
    super(`the plan said otherwise: ${message}`);
    this.name = "PlanExceededError";
  }
}

/**
 * What a handler is given, and the whole of it.
 *
 * NOTE WHAT IS ABSENT: no staging path, no member list, no lookup by name, no
 * plan. A handler sees its own effect and can read the members that effect
 * published. Everything else it would need has to be in the effect, which means
 * it has to be in the plan, which means the operator saw it.
 */
export interface ApplyContext<C> {
  /**
   * Whatever the half's apply step needs to carry through every effect -- for
   * restore that is the transaction the load runs inside. The frame does not
   * open it, close it or interpret it; it only guarantees that every effect
   * gets the same one.
   */
  readonly carrier: C;
  /** Stream a member this effect named. Refuses anything else. */
  open: (ref: StagedMemberRef) => Promise<Readable>;
  readBytes: (ref: StagedMemberRef, maxBytes?: number) => Promise<Buffer>;
  readText: (ref: StagedMemberRef, maxBytes?: number) => Promise<string>;
  /**
   * Account for `n` units of this effect's declared `count`.
   *
   * NOT OPTIONAL BOOKKEEPING. The executor requires the total to equal the
   * count when the handler returns, so a step that inserts more rows than the
   * preview promised fails at the moment it exceeds it, and one that inserts
   * fewer fails when it finishes. Call it with what was actually done.
   *
   * IT BINDS QUANTITY, NEVER IDENTITY, and the limit is stated here because a
   * reader would otherwise infer more than it gives. An effect declaring
   * "3 companies created" is satisfied by a handler that deletes three deals
   * and spends 3 -- measured, not theorised. What a step READS is constrained,
   * by `sources`; what it WRITES is not, and no arithmetic could constrain it.
   */
  spend: (n: number) => void;
}

/**
 * The handler map: one entry per operation the effect union can carry.
 *
 * EXHAUSTIVE BY THE TYPE SYSTEM. `[Op in E["op"]]` is a mapped type over the
 * union's discriminant, so the compiler requires every operation to have a
 * handler and rejects a handler for one that does not exist. That is the
 * compile-time half of "apply cannot exceed its plan"; the executor is the
 * runtime half.
 */
export type EffectHandlers<E extends PlannedEffect, C> = {
  readonly [Op in E["op"]]: (
    effect: Extract<E, { op: Op }>,
    ctx: ApplyContext<C>,
  ) => Promise<void>;
};

/** What the executor did, for the log and for the tests. */
export interface ApplyOutcome {
  /**
   * How many effects were dispatched -- their handler was called and returned.
   *
   * NOT THE SAME AS "HAPPENED", which is why `realised` exists beside it.
   */
  readonly dispatched: number;
  /**
   * How many of those are actually in the world.
   *
   * A PREPARATORY EFFECT IS NOT REALISED UNTIL ITS CONSUMER COMPLETES. On a
   * plan that ran to the end these are equal, because the executor refuses a
   * plan whose preparation has no consumer. On a FAILURE they are not, and the
   * difference is the whole point: a restore that dispatched `destroy-schema`
   * and then failed in `load-dump` destroyed nothing, because the destruction
   * was a preamble inside the transaction that rolled back.
   */
  readonly realised: number;
  /**
   * The total of every `spend`, across every effect.
   *
   * IT COUNTS ACCOUNTING, NOT REALISATION, and it counts QUANTITY, NOT
   * IDENTITY -- see ApplyContext.spend.
   */
  readonly spent: number;
  /** The ids of every member that was opened, in the order they were opened. */
  readonly opened: readonly string[];
  /** The ops of the effects that dispatched but are not realised, in plan order. */
  readonly unrealised: readonly string[];
}

/**
 * A handler failed, and this is what had happened when it did.
 *
 * ONLY THE HANDLER'S OWN FAILURES. The frame's refusals -- PlanExceededError
 * and services/intake.ts's IntakeRefError -- travel unwrapped, because "the
 * step exceeded its plan" is a different category from "the work failed" and a
 * caller has to be able to act on the difference.
 *
 * THE ERROR CARRIES THE PARTIAL OUTCOME BECAUSE THE ALTERNATIVE IS A LOG THAT
 * LIES. Without it a caller catching a mid-plan failure has no honest account
 * of how far the run got, and the temptation is to infer it from the plan --
 * which would report a destruction the transaction rolled back. `cause` is the
 * handler's own error, unwrapped, so the caller's rollback and its own error
 * handling are unaffected; the message quotes it so a `toThrow` on the original
 * text still matches.
 */
export class PlanApplyError extends Error {
  constructor(
    readonly op: string,
    readonly outcome: ApplyOutcome,
    override readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`the ${op} step failed: ${detail}`);
    this.name = "PlanApplyError";
  }
}

export interface ApplyPlanOptions<E extends PlannedEffect, C> {
  plan: Plan<E>;
  /**
   * The staging this plan was built from. Only its reader half is used, and the
   * context narrows it further to the current effect's own sources.
   */
  reader: StagedReader;
  handlers: EffectHandlers<E, C>;
  carrier: C;
}

/**
 * RUN A PLAN, AND NOTHING BUT A PLAN.
 *
 * The executor does not know what restore or import mean. It knows that a plan
 * is a list, that each entry has a handler, that each handler may read what its
 * entry named, and that each handler must account for what its entry promised.
 * Everything domain-specific lives in the handlers, and everything the operator
 * was shown lives in the effects.
 *
 * IT DOES NOT OPEN A TRANSACTION, and that is deliberate rather than an
 * omission. "Apply runs in one transaction and rolls back as a unit" is the
 * spine's rule, but the unit differs: restore's is a psql child process loading
 * a dump with --single-transaction, an importer's is a drizzle transaction over
 * this process's own pool. The frame's contribution is that every effect
 * receives the SAME carrier and that any throw -- including the two above --
 * propagates out through whatever the caller wrapped around this call, so the
 * rollback is the caller's own and cannot be half-applied by the frame.
 */
export async function applyPlan<E extends PlannedEffect, C>(
  options: ApplyPlanOptions<E, C>,
): Promise<ApplyOutcome> {
  const { plan, reader, handlers, carrier } = options;

  if (plan.refusal !== null) {
    throw new PlanRefusedError(
      plan.refusal.code,
      `this plan refuses to run: ${plan.refusal.message}`,
    );
  }
  if (plan.effects.length === 0) {
    throw new PlanRefusedError(
      "empty",
      "this plan describes nothing to do, so there is nothing to apply",
    );
  }

  // A PREPARATION WITH NO CONSUMER IS A MALFORMED PLAN, and it is refused
  // BEFORE anything dispatches. Without this an effect could leave its work on
  // the carrier for a step that is not in the plan -- a restore's DROP preamble
  // assembled and never run -- and the plan would still report success.
  plan.effects.forEach((effect, index) => {
    if (effect.realisedBy === undefined) return;
    const consumer = plan.effects.findIndex(
      (later, at) => at > index && later.op === effect.realisedBy,
    );
    if (consumer === -1) {
      throw new PlanRefusedError(
        "unrealised-preparation",
        `the ${effect.op} step only prepares work for ${JSON.stringify(effect.realisedBy)}, `
        + "and no later effect performs it",
      );
    }
  });

  const opened: string[] = [];
  let spentTotal = 0;
  let dispatched = 0;
  // Every effect that has dispatched, in plan order, with the op it is waiting
  // on. An entry stays here until that op completes.
  const awaiting: { op: string; realisedBy: string }[] = [];
  /** The outcome as it stands right now -- for the error, and for the return. */
  const snapshot = (): ApplyOutcome => ({
    dispatched,
    realised: dispatched - awaiting.length,
    spent: spentTotal,
    opened: [...opened],
    unrealised: awaiting.map((entry) => entry.op),
  });

  for (const effect of plan.effects) {
    const allowed = new Set<StagedMemberRef>(effect.sources ?? []);
    let spent = 0;
    // A HANDLER MAY NOT KEEP ITS CONTEXT. Closing it when the handler returns
    // stops a step from stashing the reader and using it during a later effect,
    // which would put reads outside the effect that declared them -- the same
    // escape as reading another effect's member, reached through time instead
    // of through the ref.
    let live = true;

    const guard = (ref: StagedMemberRef): StagedMemberRef => {
      if (!live) {
        throw new PlanExceededError(
          effect.op,
          `the ${effect.op} step read a member after it had finished`,
        );
      }
      if (!allowed.has(ref)) {
        throw new PlanExceededError(
          effect.op,
          `the ${effect.op} step tried to read ${JSON.stringify(ref.id)}, `
          + "which its effect does not name",
        );
      }
      opened.push(ref.id);
      return ref;
    };

    const ctx: ApplyContext<C> = {
      carrier,
      open: async (ref) => reader.open(guard(ref)),
      readBytes: async (ref, maxBytes) => reader.readBytes(guard(ref), maxBytes),
      readText: async (ref, maxBytes) => reader.readText(guard(ref), maxBytes),
      spend: (n) => {
        if (!live) {
          throw new PlanExceededError(
            effect.op, `the ${effect.op} step accounted for work after it had finished`,
          );
        }
        if (!Number.isInteger(n) || n < 0) {
          throw new PlanExceededError(effect.op, `${String(n)} is not a number of units`);
        }
        spent += n;
        if (spent > effect.count) {
          throw new PlanExceededError(
            effect.op,
            `the plan described ${String(effect.count)} ${effect.unit} of `
            + `${effect.subject} and the step has already done ${String(spent)}`,
          );
        }
      },
    };

    // The cast is the one place the mapped type has to be taken on trust: TS
    // cannot narrow `handlers[effect.op]` against `effect` for a union member it
    // has not discriminated. The map's own type is what guarantees the entry
    // exists and takes this effect -- there is no operation reachable here that
    // EffectHandlers did not require.
    const handler = (handlers as unknown as Record<
      string, ((e: E, c: ApplyContext<C>) => Promise<void>) | undefined
    >)[effect.op];
    if (handler === undefined) {
      throw new PlanExceededError(
        effect.op, `there is no handler for ${JSON.stringify(effect.op)}`,
      );
    }
    try {
      await handler(effect, ctx);
    } catch (error) {
      live = false;
      // THE FRAME'S OWN REFUSALS ARE NOT HANDLER FAILURES AND ARE NOT WRAPPED.
      // "This step read a member its effect does not name" is a bug in the
      // step, in a category of its own, and a caller must be able to tell it
      // apart from "the load failed". Wrapping them would also hide the shape
      // the containment tests and the mutation set assert on.
      if (error instanceof PlanExceededError || error instanceof IntakeRefError) throw error;
      // Everything else is the handler's own failure, and THE PARTIAL OUTCOME
      // TRAVELS WITH IT. `spent` for this effect is deliberately NOT added: the
      // step did not finish, so what it accounted for is not an account of
      // anything.
      throw new PlanApplyError(effect.op, snapshot(), error);
    } finally {
      live = false;
    }

    if (spent !== effect.count) {
      throw new PlanExceededError(
        effect.op,
        `the plan described ${String(effect.count)} ${effect.unit} of ${effect.subject} `
        + `and the step accounted for ${String(spent)}`,
      );
    }
    spentTotal += spent;
    dispatched += 1;
    // This effect realises every earlier preparation that named its op, and is
    // itself unrealised until its own consumer runs.
    for (let at = awaiting.length - 1; at >= 0; at -= 1) {
      if (awaiting[at]?.realisedBy === effect.op) awaiting.splice(at, 1);
    }
    if (effect.realisedBy !== undefined) {
      awaiting.push({ op: effect.op, realisedBy: effect.realisedBy });
    }
  }

  return snapshot();
}

/**
 * The plan as the page receives it.
 *
 * A PROJECTION, NOT A SECOND DESCRIPTION, and the distinction is the whole
 * design. Every effect is carried across; nothing is filtered, summarised or
 * re-derived. If this function ever gains a condition, the preview has stopped
 * being the thing that runs and has become a second implementation of it --
 * which is precisely the failure the plan-as-a-value decision exists to make
 * impossible. intake-plan.test.ts asserts the count and the field-by-field
 * equality, and was shown failing against a version of this that dropped
 * destructive effects.
 *
 * THE REFS DO NOT TRAVEL. `sources` is the one field with no wire form: it is a
 * set of object identities, meaningless to anyone else, and its absence here is
 * what makes the view plain JSON.
 */
export function planView(plan: Plan): PlanView {
  return {
    planId: plan.id,
    kind: plan.kind,
    createdAt: plan.createdAt.toISOString(),
    expiresAt: plan.expiresAt.toISOString(),
    source: plan.source,
    effects: plan.effects.map((effect) => ({
      op: effect.op,
      subject: effect.subject,
      count: effect.count,
      unit: effect.unit,
      destroys: effect.destroys,
      detail: effect.detail,
    })),
    findings: plan.findings,
    refusal: plan.refusal,
  };
}

/** How long a plan and its staged files live before the spine deletes them. */
export const PLAN_TTL_MS = 30 * 60 * 1000;

export interface NewPlanInput<E extends PlannedEffect> {
  kind: PlanKind;
  source: PlanSourceView;
  effects?: readonly E[];
  findings?: readonly PlanFindingView[];
  refusal?: PlanRefusalView | null;
  now?: Date;
  ttlMs?: number;
}

/**
 * Build a plan. One constructor for both outcomes, and that is the point.
 *
 * A REFUSAL IS A PLAN WITH NO EFFECTS, not an exception and not a separate
 * type. The page renders it through the same path, the executor refuses it
 * through the same check, and a test asserts "a backup from a newer Conduit is
 * refused" as a VALUE -- no archive extracted, no database touched, nothing
 * destroyed to find out.
 */
/**
 * One effect, copied and frozen, `sources` included.
 *
 * THE ARRAY HAS TO BE FROZEN SEPARATELY. Object.freeze is shallow, so an effect
 * frozen without this keeps a live `sources` array -- and a step's reading
 * rights are exactly that array, so a caller who could push into it could give
 * a handler a member the operator never saw listed.
 */
function freezeEffect<E extends PlannedEffect>(effect: E): E {
  const copy: PlannedEffect = { ...effect };
  if (copy.sources !== undefined) {
    (copy as { sources: readonly StagedMemberRef[] }).sources = Object.freeze([...copy.sources]);
  }
  return Object.freeze(copy) as E;
}

export function newPlan<E extends PlannedEffect>(input: NewPlanInput<E>): Plan<E> {
  const now = input.now ?? new Date();
  const refusal = input.refusal ?? null;
  // A REFUSAL CARRIES NO EFFECTS, whatever it was handed. Belt to the
  // executor's braces: a caller that built effects and then discovered the
  // refusal must not be able to publish both, because a page rendering a
  // refusal beside a list of destructions is a page nobody can act on.
  const effects = refusal === null ? (input.effects ?? []) : [];
  return Object.freeze({
    id: randomUUID(),
    kind: input.kind,
    createdAt: now,
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? PLAN_TTL_MS)),
    source: Object.freeze({ ...input.source }),
    // COPIED AND FROZEN, AND THIS IS THE PROPERTY THE PHASE RESTS ON RATHER
    // THAN A TIDINESS PASS. `map` IS THE COPY -- it builds a new array, so the
    // plan never aliases the one the caller passed in. An explicit spread
    // beside it looked like a second guarantee and was in fact unreachable
    // code: mutating it away failed nothing, which is the definition of
    // defence that is not an instrument.
    //
    // "The preview cannot lie because it is the same object apply is handed"
    // was held by CONVENTION until this line, and the module below says in its
    // own words that a property held by convention erodes at the first
    // inconvenient Tuesday. It was demonstrated: `readonly` is compile-time
    // only, the store hands back the live object, and a caller that kept a
    // reference to the array it passed in could push onto it AFTER the page had
    // rendered the preview. One harmless row was previewed and "DROP
    // EVERYTHING" ran.
    //
    // The copy defeats the retained reference; the freezes defeat a write
    // through the plan itself. Three levels, because Object.freeze is shallow
    // and a frozen array of live effects would still let a destroy be edited
    // into an insert between preview and apply.
    effects: Object.freeze(effects.map(freezeEffect)) as readonly E[],
    findings: Object.freeze((input.findings ?? []).map((f) => Object.freeze({ ...f }))),
    refusal: refusal === null ? null : Object.freeze({ ...refusal }),
  });
}

/** What the source summary looks like for a staged intake. */
export function planSource(file: IntakeFile, payload: StagedPayload): PlanSourceView {
  return {
    filename: file.filename,
    bytes: file.bytes,
    sha256: file.sha256,
    stagedBytes: payload.stagedBytes,
    memberCount: payload.members.length,
  };
}

/**
 * One held plan and the staging it was built from.
 *
 * THERE IS NO OPERATOR ON THIS TYPE, AND THE ROUTES TASK MUST ADD ONE. A plan
 * is addressable by `planId` alone, so nothing here binds it to the person who
 * uploaded the archive: any authenticated caller holding the id could apply
 * somebody else's restore. It is not exploitable as it stands -- the id is a v4
 * UUID and the store holds one session at a time -- but that is an accident of
 * capacity, not a control. The store will not do it for whoever writes the
 * routes, so they have to.
 */
export interface IntakeSession<E extends PlannedEffect = PlannedEffect> {
  readonly plan: Plan<E>;
  readonly payload: StagedPayload;
}

/**
 * WHERE A PLAN WAITS WHILE A PERSON LOOKS AT IT.
 *
 * THE PLAN NEVER TRAVELS, and this is the mechanism. Preview and apply are two
 * HTTP requests; if the plan went out and came back, the server would have to
 * re-validate it on arrival, and a re-validated plan is a second implementation
 * of inspect -- the exact thing the plan-as-a-value decision removes. So the
 * plan stays here, the page gets a rendering and an id, and apply is addressed
 * by the id. What apply consumes is byte-for-byte the object inspect produced,
 * because it IS that object.
 *
 * ONE AT A TIME BY DEFAULT, and for the disk reason services/backup.ts's
 * MAX_CONCURRENT_BACKUPS gives: a held session is an unpacked install sitting
 * in $data_dir. Two of them is two installs.
 *
 * EXPIRY IS PART OF THE CREDENTIAL DISCIPLINE, not a housekeeping nicety. What
 * expires here is a decrypted backup -- mail.key in the clear -- so a plan an
 * operator opened and wandered away from must not outlive their attention. The
 * sweep runs on every access and on an unref'd interval, so an idle process
 * still clears one and a busy one never waits for the timer.
 */
export class IntakeSessionStore {
  readonly #sessions = new Map<string, IntakeSession>();
  /**
   * The sessions currently inside `use`. Not addressable, not sweepable, and
   * not forgotten: `close` disposes of them, which is what makes a shutdown
   * during a restore leave nothing decrypted on the disk.
   */
  readonly #inFlight = new Map<string, IntakeSession>();
  readonly #capacity: number;
  readonly #now: () => Date;
  readonly #timer: NodeJS.Timeout | null;

  constructor(options: {
    capacity?: number;
    now?: () => Date;
    /** Milliseconds between background sweeps. 0 disables the timer (tests). */
    sweepIntervalMs?: number;
  } = {}) {
    this.#capacity = options.capacity ?? 1;
    this.#now = options.now ?? (() => new Date());
    const interval = options.sweepIntervalMs ?? 60_000;
    this.#timer = interval > 0 ? setInterval(() => { void this.sweep(); }, interval) : null;
    // An intake store must never be the reason a process refuses to exit.
    this.#timer?.unref();
  }

  /**
   * Hold a plan and its staging. Throws when the store is full, having disposed
   * of nothing: a caller who cannot be held has to dispose of its own payload,
   * and a store that silently evicted somebody else's in-flight restore would
   * be worse than a refusal.
   */
  hold<E extends PlannedEffect>(session: IntakeSession<E>): string {
    void this.sweep();
    if (this.#sessions.size >= this.#capacity) {
      throw new PlanRefusedError(
        "busy",
        "another upload is already waiting for a decision; finish or cancel it first",
      );
    }
    this.#sessions.set(session.plan.id, session as IntakeSession);
    return session.plan.id;
  }

  /** The held session, or undefined when the id is unknown or has expired. */
  get(planId: string): IntakeSession | undefined {
    void this.sweep();
    return this.#sessions.get(planId);
  }

  /**
   * Run `body` against the held session, once, and delete its staged files
   * however that turns out.
   *
   * THIS REPLACED A `take()` THAT ORPHANED A DECRYPTED BACKUP. That method
   * removed the session from the map and handed it over; nothing disposed of
   * it, so `sweep` and `close` could no longer reach it and the only remaining
   * net was a boot-time sweep that has no production caller yet. What was left
   * in $data_dir was an unpacked backup with mail.key IN THE CLEAR -- against
   * the one discipline this whole spine is built on.
   *
   * So the lifetime is not the caller's to remember. It is a scope:
   *
   *   - REMOVED FROM THE MAP BEFORE THE WORK STARTS, which is what `take` got
   *     right. A second apply of the same plan is a double restore, and the
   *     window in which that is possible must not span the first one.
   *   - HELD IN FLIGHT WHILE `body` RUNS, so `close` can still reach it if the
   *     process is shut down mid-restore.
   *   - DISPOSED IN A `finally`, so a throw from apply -- which is the ordinary
   *     failure, not the exotic one -- deletes the staging on its way out.
   *
   * Returns undefined without running anything when the id is unknown or has
   * expired. The body's own value is returned otherwise, so the route can send
   * a response built from it.
   */
  async use<T>(
    planId: string, body: (session: IntakeSession) => Promise<T>,
  ): Promise<T | undefined> {
    void this.sweep();
    const session = this.#sessions.get(planId);
    if (session === undefined) return undefined;
    this.#sessions.delete(planId);
    this.#inFlight.set(planId, session);
    try {
      return await body(session);
    } finally {
      this.#inFlight.delete(planId);
      try {
        await session.payload.dispose();
      } catch { /* an undeletable staging is not a reason to lose the outcome */ }
    }
  }

  /** Drop a session and delete its staged files. Idempotent. */
  async discard(planId: string): Promise<boolean> {
    const session = this.#sessions.get(planId);
    if (session === undefined) return false;
    this.#sessions.delete(planId);
    await session.payload.dispose();
    return true;
  }

  /** How many sessions are inside `use` right now. For the tests. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** Delete every expired session's staged files. Never throws. */
  async sweep(): Promise<number> {
    const now = this.#now().getTime();
    let removed = 0;
    for (const [id, session] of [...this.#sessions]) {
      if (session.plan.expiresAt.getTime() > now) continue;
      this.#sessions.delete(id);
      removed += 1;
      try {
        await session.payload.dispose();
      } catch { /* an undeletable staging is not a reason to fail the next intake */ }
    }
    return removed;
  }

  /** How many sessions are held right now. */
  get size(): number {
    return this.#sessions.size;
  }

  /**
   * Drop everything and stop the timer. For shutdown and for tests.
   *
   * BOTH MAPS, and the in-flight one is the reason this matters: a process shut
   * down in the middle of a restore would otherwise leave a decrypted backup in
   * $data_dir with nothing left holding a reference to it.
   */
  async close(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    for (const map of [this.#sessions, this.#inFlight]) {
      for (const [id, session] of [...map]) {
        map.delete(id);
        try {
          await session.payload.dispose();
        } catch { /* as above */ }
      }
    }
  }
}
