import net from "node:net";

/**
 * A DIRECTORY THAT CAN REFUSE, WHICH IS THE ENTIRE POINT OF IT.
 *
 * WHAT IT REPLACES AND WHY. The stand-in for the portal API answered 200 to
 * every request it ever received, so the re-authentication gate's SUCCESS path
 * was never once measured against anything implementing the door's actual
 * rule -- and the gate shipped refusing every correct password on the deploy
 * target (v1.4.1 Task 0). A fixture that cannot fail turns a broken gate into a
 * green suite, which is worse than having no fixture at all.
 *
 * SO THIS SPEAKS THE WIRE. Enough of RFC 4511 over a real TCP socket for ldapts
 * to connect, bind, ask whoami and unbind: BER in, BER out, with no seam inside
 * the client library and no mock's recollection of what was sent. The answers
 * it must be able to give are the ones the verifier branches on -- 49 for a
 * wrong password, SUCCESS for a bind carrying a DN and no password (see
 * `unauthenticatedBind`), an identity that is not the one that bound, and
 * nothing at all for a directory that has stopped answering.
 *
 * WHY NOT A REAL slapd: no developer machine and no GitHub runner has one, and
 * the deploy target's own directory is not a fixture -- binding as a real
 * account needs that account's real password. What was measured against it on
 * 2 Sep is quoted at the branches it decides, rather than assumed here.
 */

/**
 * RFC 4532's "Who am I?", the extended operation YunoHost's own authenticator
 * uses to ask the directory who it thinks just bound.
 */
export const WHOAMI_OID = "1.3.6.1.4.1.4203.1.11.3";

export interface FakeDirectoryOptions {
  /**
   * DN to password. Matched case-insensitively on the DN, because that is what
   * a directory does: `uid` is caseIgnoreMatch in RFC 4519, so two DNs
   * differing only in case name the same entry.
   */
  accounts?: Record<string, string>;
  /**
   * What this directory does with a bind that NAMES A DN AND SENDS A
   * ZERO-LENGTH PASSWORD.
   *
   * MEASURED ON THE DEPLOY TARGET, 2 Sep, slapd 2.5.13, using a username that
   * does not exist so that nobody's credentials were involved:
   *
   *   ldapwhoami -x -H ldap://127.0.0.1:389 \
   *     -D uid=conduit-probe-no-such-user,ou=users,dc=yunohost,dc=org -w ""
   *   ldap_bind: Server is unwilling to perform (53)
   *     additional info: unauthenticated bind (DN with no password) disallowed
   *
   * That is OpenLDAP's default -- `allow bind_anon_dn` is not set on that box --
   * and it is NOT what Task 0's brief assumed. "unwilling" reproduces it.
   *
   * "success-as-anonymous" IS STILL THE DEFAULT HERE, deliberately. It is what
   * RFC 4513 s5.1.2 calls the unauthenticated authentication mechanism, it is
   * what that same slapd does the moment somebody adds `allow bind_anon_dn`,
   * and that line lives in a config file Conduit does not own and cannot see. A
   * fixture should default to the configuration in which the code under test is
   * DANGEROUS, not to the one in which it happens to be lucky.
   */
  unauthenticatedBind?: "success-as-anonymous" | "unwilling";
  /**
   * Answer EVERY bind with this result code, whatever was sent.
   *
   * For the codes that are neither success nor 49: 51 (busy), 52
   * (unavailable), 53 (unwilling). A directory that is shutting down or
   * refusing work has said nothing about the password, and the difference
   * between "said nothing" and "said no" is the whole of this release.
   */
  answerBindWith?: number;
  /**
   * Answer whoami with this authorization identity rather than the session's
   * own.
   *
   * The only way to stage "the bind succeeded, but as somebody else". A
   * directory that does this is misconfigured or is a proxy, and the verifier
   * is required to disbelieve it either way.
   */
  whoamiAs?: string;
  /** Accept the connection and then answer nothing, ever. */
  silent?: boolean;
}

export interface FakeDirectory {
  /** `ldap://127.0.0.1:<port>`, ready to hand to a Client. */
  url: string;
  /**
   * Every bind this directory was asked for, in order, EXACTLY AS IT ARRIVED ON
   * THE WIRE.
   *
   * The DN here is the string the client really sent, which is what makes the
   * escaping assertions worth anything: a test that built its expectation with
   * the same helper the verifier uses would only ever agree with itself.
   */
  binds: { dn: string; password: string }[];
  /** Connections currently open. The instrument the unbind assertions read. */
  openConnections: () => number;
  close: () => Promise<void>;
}

const TAG_SEQUENCE = 0x30;
const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_ENUMERATED = 0x0a;
const TAG_BIND_REQUEST = 0x60;
const TAG_BIND_RESPONSE = 0x61;
const TAG_UNBIND_REQUEST = 0x42;
const TAG_EXTENDED_REQUEST = 0x77;
const TAG_EXTENDED_RESPONSE = 0x78;
/**
 * Context-specific, primitive, number 0: the `simple` arm of a BindRequest's
 * AuthenticationChoice, and also an ExtendedRequest's requestName.
 */
const TAG_CONTEXT_0 = 0x80;
/** An ExtendedResponse's responseValue, [11]. ldapts reads it at exactly this tag. */
const TAG_RESPONSE_VALUE = 0x8b;

const RESULT_SUCCESS = 0;
const RESULT_INVALID_CREDENTIALS = 49;
const RESULT_UNWILLING_TO_PERFORM = 53;

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

function encodeInteger(value: number): Buffer {
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  if (bytes.length === 0) bytes.push(0);
  // A leading bit of 1 would be read back as a negative two's-complement value.
  if ((bytes[0] ?? 0) >= 0x80) bytes.unshift(0);
  return Buffer.from(bytes);
}

interface Field { tag: number; value: Buffer; end: number }

/**
 * One tag-length-value at `at`, or null when the buffer does not hold all of it
 * yet.
 *
 * NULL IS NOT AN ERROR, and that distinction is what makes this safe against a
 * TCP stream rather than against a series of neat messages: it means "come back
 * when more has arrived", which is the ordinary case for a message split across
 * two packets.
 */
function readField(buffer: Buffer, at: number): Field | null {
  if (at + 2 > buffer.length) return null;
  const tag = buffer.readUInt8(at);
  const first = buffer.readUInt8(at + 1);
  let length = first;
  let contentsAt = at + 2;
  if ((first & 0x80) !== 0) {
    const count = first & 0x7f;
    // Indefinite length (0) is not legal in LDAP's BER subset, and nothing
    // sends a four-gigabyte message to a fixture.
    if (count === 0 || count > 4 || at + 2 + count > buffer.length) return null;
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + buffer.readUInt8(at + 2 + i);
    contentsAt = at + 2 + count;
  }
  if (contentsAt + length > buffer.length) return null;
  return { tag, value: buffer.subarray(contentsAt, contentsAt + length), end: contentsAt + length };
}

function readInteger(field: Field): number {
  let value = 0;
  for (const byte of field.value) value = value * 256 + byte;
  return value;
}

function ldapMessage(messageId: number, operation: Buffer): Buffer {
  return tlv(TAG_SEQUENCE, Buffer.concat([tlv(TAG_INTEGER, encodeInteger(messageId)), operation]));
}

function ldapResult(
  tag: number,
  code: number,
  diagnostic = "",
  // Annotated rather than inferred from the default: Buffer.alloc narrows to
  // Buffer<ArrayBuffer>, and Buffer.concat's result is Buffer<ArrayBufferLike>,
  // which is not assignable to it.
  extra: Buffer = Buffer.alloc(0),
): Buffer {
  return tlv(tag, Buffer.concat([
    tlv(TAG_ENUMERATED, Buffer.from([code])),
    tlv(TAG_OCTET_STRING, Buffer.alloc(0)), // matchedDN
    tlv(TAG_OCTET_STRING, Buffer.from(diagnostic, "utf8")),
    extra,
  ]));
}

export async function startFakeDirectory(
  options: FakeDirectoryOptions = {},
): Promise<FakeDirectory> {
  const accounts = new Map(
    Object.entries(options.accounts ?? {}).map(([dn, password]) => [dn.toLowerCase(), password]),
  );
  const binds: { dn: string; password: string }[] = [];
  // Held so that close() can destroy them. net.Server has no
  // closeAllConnections() -- that is http.Server's -- and its own close() only
  // stops it listening, so without this a leaked connection would keep the
  // event loop alive until vitest gave up on the whole file.
  const live = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    live.add(socket);
    socket.on("close", () => { live.delete(socket); });
    // The identity this CONNECTION is bound as. Empty is anonymous, which is
    // the state every connection starts in and the state an unauthenticated
    // bind returns it to.
    let boundDn = "";
    let pending = Buffer.alloc(0);

    socket.on("error", () => { /* a client that vanishes mid-message is a test ending */ });
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const message = readField(pending, 0);
        if (message === null) return;
        pending = pending.subarray(message.end);
        const idField = readField(message.value, 0);
        if (idField === null) return;
        const messageId = readInteger(idField);
        const operation = readField(message.value, idField.end);
        if (operation === null) return;
        if (options.silent === true) continue;

        if (operation.tag === TAG_UNBIND_REQUEST) {
          socket.end();
          return;
        }

        if (operation.tag === TAG_BIND_REQUEST) {
          const version = readField(operation.value, 0);
          const name = version === null ? null : readField(operation.value, version.end);
          const auth = name === null ? null : readField(operation.value, name.end);
          if (name === null || auth === null || auth.tag !== TAG_CONTEXT_0) {
            socket.write(ldapMessage(messageId, ldapResult(
              TAG_BIND_RESPONSE, RESULT_UNWILLING_TO_PERFORM, "only simple binds are implemented",
            )));
            continue;
          }
          const dn = name.value.toString("utf8");
          const password = auth.value.toString("utf8");
          binds.push({ dn, password });

          if (options.answerBindWith !== undefined) {
            boundDn = "";
            socket.write(ldapMessage(messageId, ldapResult(
              TAG_BIND_RESPONSE, options.answerBindWith, "the fixture was told to answer this",
            )));
            continue;
          }

          if (password.length === 0) {
            // A bind naming NOBODY with no password is the ordinary anonymous
            // bind, which every directory allows and so does this one --
            // measured: `ldapwhoami -x` against the deploy target answers
            // "anonymous" rather than an error. The dangerous case is the
            // other one: a DN with no password.
            if (dn.length === 0 || options.unauthenticatedBind !== "unwilling") {
              boundDn = "";
              socket.write(ldapMessage(messageId, ldapResult(TAG_BIND_RESPONSE, RESULT_SUCCESS)));
            } else {
              socket.write(ldapMessage(messageId, ldapResult(
                TAG_BIND_RESPONSE, RESULT_UNWILLING_TO_PERFORM,
                "unauthenticated bind (DN with no password) disallowed",
              )));
            }
            continue;
          }

          if (accounts.get(dn.toLowerCase()) === password) {
            boundDn = dn;
            socket.write(ldapMessage(messageId, ldapResult(TAG_BIND_RESPONSE, RESULT_SUCCESS)));
          } else {
            // 49 for a wrong password AND for an account that does not exist,
            // which is the directory's own behaviour rather than a
            // simplification of it: measured against the deploy target, a bind
            // as uid=conduit-probe-no-such-user answers "Invalid credentials
            // (49)" exactly as a wrong password does.
            boundDn = "";
            socket.write(ldapMessage(
              messageId, ldapResult(TAG_BIND_RESPONSE, RESULT_INVALID_CREDENTIALS),
            ));
          }
          continue;
        }

        if (operation.tag === TAG_EXTENDED_REQUEST) {
          const oidField = readField(operation.value, 0);
          const oid = oidField === null ? "" : oidField.value.toString("utf8");
          if (oid !== WHOAMI_OID) {
            socket.write(ldapMessage(messageId, ldapResult(
              TAG_EXTENDED_RESPONSE, RESULT_UNWILLING_TO_PERFORM,
              `no such extended operation: ${oid}`,
            )));
            continue;
          }
          const identity = options.whoamiAs ?? (boundDn === "" ? "" : `dn:${boundDn}`);
          // RFC 4532: an ANONYMOUS session answers with an ABSENT response
          // value. The word "anonymous" that ldapwhoami prints is its own
          // rendering of that absence, not something on the wire -- and an
          // empty field present is a different message from no field at all,
          // so the verifier has to survive the one a directory really sends.
          const extra = identity === ""
            ? Buffer.alloc(0)
            : tlv(TAG_RESPONSE_VALUE, Buffer.from(identity, "utf8"));
          socket.write(ldapMessage(
            messageId, ldapResult(TAG_EXTENDED_RESPONSE, RESULT_SUCCESS, "", extra),
          ));
          continue;
        }

        socket.write(ldapMessage(messageId, ldapResult(
          TAG_EXTENDED_RESPONSE, RESULT_UNWILLING_TO_PERFORM, "not implemented by this fixture",
        )));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fixture got no port");

  return {
    url: `ldap://127.0.0.1:${String(address.port)}`,
    binds,
    openConnections: () => live.size,
    close: () => new Promise<void>((resolve) => {
      // Connections are destroyed rather than waited for. A verifier that
      // failed to unbind is precisely the defect the unbind assertions look
      // for, and a fixture that hung waiting for it would report that defect as
      // a suite-level timeout instead of as a failed assertion.
      for (const socket of live) socket.destroy();
      server.close(() => { resolve(); });
    }),
  };
}
