import { describe, expect, it } from "vitest";
import type { FastifyReply } from "fastify";
import { RenderBusyError, RenderError } from "../services/documents-render.js";
import { TemplateError } from "../services/documents-template.js";
import {
  DocumentInputError, DocumentTemplateMissingError, DocumentTooLargeError,
} from "../services/documents.js";
import { OrgProfileInputError } from "../services/org-profile.js";
import { NotFoundError, ArchivedError } from "../services/errors.js";
import { mapDocumentError } from "./documents.js";

/**
 * THE REFUSAL TABLE, TESTED AS A TABLE.
 *
 * Every arm here is reachable from the issuing route, and two of them were reachable
 * only in principle: the 503 for a saturated renderer had no test anywhere, so
 * deleting it degraded a busy server's answer to 422 with the whole suite green. The
 * arms are ordered -- RenderBusyError extends RenderError, and DocumentTooLargeError
 * sits beside renderPdf's own cap -- so an ordering mistake is the likely regression
 * and a table is what catches one.
 *
 * A stub reply rather than a live server: what is under test is the mapping, and a
 * fake that records the last code and body exercises it directly, including the two
 * cases (a saturated render queue, a driver SQLSTATE) that a route test could only
 * reach by holding slots for ten seconds or by corrupting a column.
 */
function stubReply(): FastifyReply & { sent: { status: number; body: unknown } } {
  const state = { status: 0, body: undefined as unknown };
  const reply = {
    sent: state,
    code(status: number) { state.status = status; return this; },
    send(body: unknown) { state.body = body; return this; },
  };
  return reply as unknown as FastifyReply & { sent: { status: number; body: unknown } };
}

function map(error: unknown): { status: number; code: string; message: string } {
  const reply = stubReply();
  mapDocumentError(reply, error);
  const body = reply.sent.body as { error: string; message: string };
  return { status: reply.sent.status, code: body.error, message: body.message };
}

describe("mapDocumentError", () => {
  const cases: [string, unknown, number, string][] = [
    ["the input gate", new DocumentInputError("bad line"), 400, "validation"],
    ["a rejected issuer profile", new OrgProfileInputError("logo too big"), 400, "validation"],
    ["a deleted template", new DocumentTemplateMissingError("quote"), 409, "template_missing"],
    ["a template that cannot merge", new TemplateError("too deep"), 422, "template_error"],
    ["a document too large to render", new DocumentTooLargeError("merges to 200000"), 413, "too_large"],
    ["the renderer's own input cap", new RenderError("document is too large to render"), 413, "too_large"],
    ["a saturated render queue", new RenderBusyError("the renderer is busy"), 503, "renderer_busy"],
    ["any other render failure", new RenderError("renderer exited 5"), 422, "render_failed"],
    ["an unknown deal", new NotFoundError("deal", "x"), 404, "not_found"],
    ["an archived deal", new ArchivedError("deal", "x"), 409, "archived"],
  ];

  for (const [label, error, status, code] of cases) {
    it(`answers ${String(status)} ${code} for ${label}`, () => {
      expect(map(error)).toMatchObject({ status, code });
    });
  }

  it("answers 503 for a lock timeout, because retrying is the right thing to do", () => {
    // 55P03, lock_not_available. Two quotes of the same type and year serialise on
    // one sequence row and the issuing transaction sets a lock_timeout, so a pile-up
    // fails rather than holding a pooled connection indefinitely. Nothing was spent:
    // the timeout fires before the number is allocated.
    const driverError = Object.assign(new Error("Failed query"), { cause: { code: "55P03" } });
    expect(map(driverError)).toMatchObject({ status: 503, code: "busy" });
  });

  it("re-throws anything it does not know, so an unexpected failure stays a 5xx", () => {
    // The arms above are refusals a caller can act on. A bug must not be dressed up
    // as one: it goes to app.ts's error handler, which logs it and never echoes it.
    expect(() => { mapDocumentError(stubReply(), new Error("something unforeseen")); })
      .toThrow("something unforeseen");
  });

  it("keeps the renderer's stderr off the wire", () => {
    // RenderError.detail carries the child's stderr, which can name server paths.
    // Only `message` -- one of this codebase's own short phrases -- is echoed.
    const error = new RenderError("renderer exited 5", "/home/chris/secret/path: no such font");
    expect(map(error).message).toBe("renderer exited 5");
    expect(JSON.stringify(map(error))).not.toContain("/home/chris");
  });
});
