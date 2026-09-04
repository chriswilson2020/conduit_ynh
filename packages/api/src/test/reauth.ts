import type { FastifyInstance } from "fastify";
import type { ReauthScope } from "@conduit/shared";
import { createFixedPasswordVerifier } from "../services/reauth.js";
import type { ReauthVerifier } from "../services/reauth.js";

/**
 * WHAT THE 7.6 DOWNLOAD TESTS NEED IN ORDER TO GET PAST THE GATE.
 *
 * Task 3 put a re-authentication gate in front of GET /api/export and
 * POST /api/backup, so every existing test of those routes now has to prove it
 * is the operator before it can assert anything about an archive. This is that
 * proof, in one place, so the two suites do not each grow their own.
 *
 * THE VERIFIER IS REAL, NOT A STUB THAT SAYS YES. `createFixedPasswordVerifier`
 * is the same function a development or CI deployment uses (config.ts refuses
 * it in production), and it compares the password properly -- so a test that
 * forgets the header, or sends the wrong password, gets the same 401 a stranger
 * would. A `() => true` verifier here would have made every one of these suites
 * pass a gate that was not there.
 */
export const TEST_REAUTH_PASSWORD = "correct-horse-battery-staple";

export function testReauthVerifier(): ReauthVerifier {
  return createFixedPasswordVerifier(TEST_REAUTH_PASSWORD);
}

/**
 * Mint one ticket, through the real endpoint, for the identity in `headers`
 * and for one operation.
 *
 * THROUGH POST /api/reauth RATHER THAN OUT OF THE TICKET STORE, deliberately:
 * a helper that reached into ReauthTickets would let the download tests keep
 * passing if /api/reauth broke entirely, and would not exercise the binding
 * between the ticket and the account it was issued to.
 *
 * THE SCOPE HAS NO DEFAULT, and that is the point of it being a parameter
 * rather than a field with a sensible value. v1.4.1 bound a ticket to the
 * operation it was minted for; a helper that guessed the operation would let a
 * test of the backup route quietly mint an export's ticket and still pass,
 * which is the fungibility this release removed wearing a test's clothes.
 */
export async function reauthTicket(
  app: FastifyInstance,
  headers: Record<string, string>,
  scope: ReauthScope,
): Promise<string> {
  const response = await app.inject({
    method: "POST", url: "/api/reauth", headers,
    payload: { password: TEST_REAUTH_PASSWORD, scope },
  });
  if (response.statusCode !== 200) {
    throw new Error(`could not mint a re-auth ticket: ${String(response.statusCode)} ${response.body}`);
  }
  return (response.json() as { ticket: string }).ticket;
}

/**
 * `headers` plus a freshly minted, single-use ticket for `scope`.
 *
 * One call, one download. A caller that needs two requests to succeed calls
 * this twice, which is the contract rather than an inconvenience.
 */
export async function reauthedHeaders(
  app: FastifyInstance,
  headers: Record<string, string>,
  scope: ReauthScope,
): Promise<Record<string, string>> {
  return { ...headers, "x-conduit-reauth": await reauthTicket(app, headers, scope) };
}
