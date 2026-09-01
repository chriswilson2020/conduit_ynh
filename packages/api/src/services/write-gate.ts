/**
 * "REFUSE NEW WRITES" -- SPEC STEP 5's OTHER HALF, IN THE ONLY LAYER THAT CAN
 * SEE A REQUEST.
 *
 * services/restore.ts stops the mail sync around the whole apply, and says in
 * its own header why it cannot do this half: a service that is handed a
 * database and a plan has no way to know that a browser in another tab is
 * posting a company. The argument for stopping the sync is the argument for
 * this, word for word -- A RESTORE IS ONLY TRUE IF NOTHING ELSE IS WRITING,
 * and an operator with a second tab open is exactly as much a second writer as
 * the sync engine. Both halves of step 5 were prescribed together and only one
 * of them existed.
 *
 * WHAT COUNTS AS A WRITE IS THE HTTP METHOD, AND THAT IS A DECISION RATHER THAN
 * A SHORTCUT. The alternative is a list of the routes that mutate, and a list
 * is a thing that goes stale the first time somebody adds a route and does not
 * think about restore -- silently, in the direction that lets a write through.
 * The method is carried by every request there will ever be, cannot be
 * forgotten by a new route, and is what RFC 9110 already calls safe. The cost
 * is that a POST which happens to write nothing is refused too, which is the
 * harmless direction.
 *
 * THE GATE RUNS BEFORE IDENTITY IS RESOLVED, and app.ts registers it in that
 * order deliberately. Resolving a user WRITES to the database on a cache miss
 * (see createUserResolver), and during a restore that write would block behind
 * the DROP SCHEMA's ACCESS EXCLUSIVE lock -- so a gate placed after the auth
 * hook would hang the very requests it exists to refuse quickly.
 *
 * WHAT THE METHOD CANNOT SEE, NAMED RATHER THAN LEFT TO BE FOUND: a GET that
 * writes. This application has exactly one, and it is the identity resolution
 * named in the paragraph above -- a read from an identity that is not in
 * createUserResolver's cache INSERTS a users row. Reads
 * are admitted (the spec's step 5 says writes, and a page that could not report
 * what was happening would be worse than useless during the one operation an
 * operator watches), so such a request can insert a row while a restore runs.
 *
 * THE WINDOW THAT MATTERS IS SUB-MILLISECOND AND THE CONSEQUENCE IS A FALSE
 * ALARM, not damage. Before the load's COMMIT the row is inside what the
 * transaction replaces; after the inventory has been counted it is an ordinary
 * row in a restored install. Between the two -- the few instructions between
 * COMMIT and measureInventory -- an extra users row would make the inventory
 * check report a disagreement about a restore that worked, at the loudest
 * volume this product has. It needs a request from an identity the running
 * process has never seen, inside that window, and the operator watching the
 * restore is by definition cached.
 *
 * IT IS NOT CLOSED HERE BECAUSE BOTH WAYS OF CLOSING IT ARE WORSE. Refusing
 * reads contradicts step 5 and blinds the page; making identity resolution
 * refuse to write while the gate is closed changes what authentication means
 * during a restore, in a file this task has no business editing. It is written
 * down instead, the way services/restore.ts writes down its own residual
 * window around mail.key.
 *
 * DRAINING IS THE HALF THAT IS EASY TO LEAVE OUT. Closing the gate stops the
 * NEXT write; it says nothing about the one that is already inside a handler
 * with a transaction open. So the gate counts what is in flight and the restore
 * waits for that count to fall to zero before it destroys anything. The wait is
 * bounded, and a wait that runs out REFUSES THE RESTORE rather than proceeding:
 * a restore that did not start is recoverable by pressing the button again, and
 * a restore that destroyed the database under a live writer is not.
 *
 * IT IS PER PROCESS, which is the whole deployment -- one systemd unit, one
 * node process (conf/systemd.service). Nothing here would survive being run
 * twice, and neither would the restore it guards.
 */

/**
 * The methods that cannot change anything, per RFC 9110's "safe" definition.
 *
 * TRACE is absent because Fastify does not route it by default and adding it to
 * this set would be describing a capability this app does not have.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a request with this method could change something. */
export function isWriteMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * How long a restore waits for writes that were already running.
 *
 * FIFTEEN SECONDS, and the number is chosen from what the app's own slowest
 * ordinary write costs rather than from a round figure: a compose-and-send goes
 * out over SMTP and then APPENDs to IMAP, and mail-sync's own stop deadline is
 * the same 15s for the same reason. Long enough that a genuine request finishes;
 * short enough that an operator watching a spinner is told something rather than
 * left to wonder.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

/** What a drain found when it stopped waiting. */
export interface DrainResult {
  /** True when nothing but the caller itself was still writing. */
  readonly drained: boolean;
  /** Writes still in flight, not counting the request that asked. */
  readonly stillWriting: number;
}

/**
 * The gate was already closed when somebody asked to close it.
 *
 * IT IS NOT A THEORETICAL STATE, and getting it wrong is the worst kind of bug
 * this module could have. Two applies can both pass the onRequest hook while
 * the gate is still open and only then race in their handlers -- there are
 * awaits between the two points, one of them a scrypt. Without this refusal the
 * SECOND caller would close an already-closed gate, fail, and REOPEN IT in its
 * own `finally` -- admitting writes for the whole of the first caller's
 * restore, which is the one thing the gate exists to prevent. So a second
 * closer is refused before it can own anything, and therefore never reaches a
 * `resume` it has no right to call.
 */
export class WriteGateBusyError extends Error {
  constructor() {
    super("writes are already being refused; something else is holding this gate");
    this.name = "WriteGateBusyError";
  }
}

export interface RefuseWritesOptions {
  /** Sent to every refused caller. Written for a person, not a log. */
  reason: string;
  /**
   * The request id of the caller itself, which is a write and must not be
   * waited for.
   *
   * WITHOUT IT THE DRAIN NEVER FINISHES. POST /api/restore/apply passes through
   * this gate like any other write, so it is inside the in-flight set when it
   * asks the gate to close -- and a drain that waited for the set to empty
   * would be waiting for itself.
   */
  except?: string;
  timeoutMs?: number;
}

export class WriteGate {
  /** Why writes are being refused, or null when they are not. */
  #reason: string | null = null;
  /** The request that asked for the closure, which the drain ignores. */
  #except: string | undefined = undefined;
  /** Write requests that are past the gate and have not answered yet. */
  readonly #inFlight = new Set<string>();
  /** Resolvers waiting for the in-flight set to drain. */
  #waiters: ((drained: boolean) => void)[] = [];

  /** Whether new writes are being refused right now. */
  get refusing(): boolean {
    return this.#reason !== null;
  }

  /** The sentence a refused caller is told, or null when nothing is refused. */
  get reason(): string | null {
    return this.#reason;
  }

  /** Write requests past the gate and not yet answered. For the tests. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /**
   * Let one write in, recording it, or refuse it.
   *
   * READ AND WRITE IN ONE SYNCHRONOUS STEP, exactly as ReauthThrottle.reserve
   * is and for the same reason: node runs one turn of the event loop at a time,
   * so a method that decides and records without awaiting cannot be interleaved.
   * A version that checked `refusing` and then registered after an await would
   * let every request that arrived inside the await through a closed gate.
   */
  admit(id: string): boolean {
    if (this.#reason !== null) return false;
    this.#inFlight.add(id);
    return true;
  }

  /**
   * This write has answered. Idempotent, because it is called from more than
   * one hook: `onResponse` for an ordinary answer and `onRequestAbort` for a
   * client that hung up, and a request that was REFUSED was never admitted at
   * all.
   */
  finish(id: string): void {
    if (!this.#inFlight.delete(id)) return;
    this.#settle();
  }

  /**
   * Stop admitting writes, then wait for the ones already inside to finish.
   *
   * THE ORDER IS THE WHOLE POINT. Closing first and waiting second means the
   * set can only shrink; waiting first would be chasing a queue that is still
   * being fed. `resume` must be called by WHOEVER CLOSED IT however this turns
   * out -- including on the timeout path, where the restore does not start and
   * the install has to go on serving.
   *
   * Throws WriteGateBusyError when the gate is already closed, and throws
   * before touching anything, so a caller that catches it has acquired nothing
   * and must not resume.
   */
  async refuseNewWrites(options: RefuseWritesOptions): Promise<DrainResult> {
    if (this.#reason !== null) throw new WriteGateBusyError();
    this.#reason = options.reason;
    this.#except = options.except;
    const timeoutMs = options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    if (this.#isDrained()) return { drained: true, stillWriting: 0 };

    const drained = await new Promise<boolean>((resolve) => {
      const waiter = (result: boolean): void => {
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((candidate) => candidate !== waiter);
        resolve(false);
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
    return { drained, stillWriting: this.#others() };
  }

  /**
   * Admit writes again.
   *
   * Idempotent, and it never throws: it is called from a `finally` around the
   * most dangerous operation in the product, where a throw would replace the
   * message the operator needs with one about a gate.
   */
  resume(): void {
    this.#reason = null;
    this.#except = undefined;
    const waiters = this.#waiters;
    this.#waiters = [];
    // A drain that was still waiting when the gate reopened did not drain. It
    // is told so rather than left to time out, because its caller is holding a
    // decision open on the answer.
    for (const waiter of waiters) waiter(false);
  }

  /** In-flight writes other than the one that asked for the closure. */
  #others(): number {
    let count = 0;
    for (const id of this.#inFlight) if (id !== this.#except) count += 1;
    return count;
  }

  #isDrained(): boolean {
    return this.#others() === 0;
  }

  #settle(): void {
    if (this.#reason === null || !this.#isDrained()) return;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter(true);
  }
}
