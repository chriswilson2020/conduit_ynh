import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { emailTemplateSchema, type SseHint } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import {
  listTemplates, getTemplate, createTemplate, updateTemplate, archiveTemplate, unarchiveTemplate,
} from "./mail-templates.js";
import { NotFoundError, ArchivedError, ConflictError } from "./errors.js";
import { subscribe } from "./sse.js";

const handle = openTestDatabase();

beforeEach(async () => {
  await truncateAll(handle);
});
afterAll(async () => { await handle.close(); });

const UNKNOWN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function captureHints(): { hints: SseHint[]; stop: () => void } {
  const hints: SseHint[] = [];
  const stop = subscribe((hint) => hints.push(hint));
  return { hints, stop };
}

describe("mail templates", () => {
  it("creates a shared template, sanitizes the body on write, and publishes the templates hint", async () => {
    const { hints, stop } = captureHints();
    try {
      const template = await createTemplate(handle.db, {
        name: "Intro",
        subject: "Hello from Conduit",
        bodyHtml: '<p onclick="steal()">Hi <b>there</b></p><script>alert(1)</script>',
      });
      expect(emailTemplateSchema.safeParse(template).success).toBe(true);
      expect(template.bodyHtml).toContain("<b>there</b>");
      expect(template.bodyHtml).not.toContain("script");
      expect(template.bodyHtml).not.toContain("onclick");
      expect(hints).toEqual([{ keys: [["email-templates"]] }]);
    } finally {
      stop();
    }
  });

  it("defaults subject to the empty string when none is submitted", async () => {
    const template = await createTemplate(handle.db, { name: "Bare", bodyHtml: "<p>Body</p>" });
    expect(template.subject).toBe("");
  });

  it("refuses a body that sanitizes away to nothing rather than storing an unparseable row", async () => {
    await expect(createTemplate(handle.db, { name: "Hostile", bodyHtml: "<script>alert(1)</script>" }))
      .rejects.toThrow(ConflictError);
    expect(await listTemplates(handle.db)).toHaveLength(0);
  });

  it("is shared, not owner-scoped: every template appears in one alphabetical list", async () => {
    await createTemplate(handle.db, { name: "Zulu", bodyHtml: "<p>z</p>" });
    await createTemplate(handle.db, { name: "Alpha", bodyHtml: "<p>a</p>" });
    const templates = await listTemplates(handle.db);
    expect(templates.map((t) => t.name)).toEqual(["Alpha", "Zulu"]);
  });

  it("patches name/subject/body, re-sanitizing the new body", async () => {
    const created = await createTemplate(handle.db, { name: "Intro", bodyHtml: "<p>Old</p>" });
    const updated = await updateTemplate(handle.db, created.id, {
      name: "Intro v2", bodyHtml: '<p>New</p><iframe src="https://evil.example"></iframe>',
    });
    expect(updated.name).toBe("Intro v2");
    expect(updated.subject).toBe("");
    expect(updated.bodyHtml).toContain("New");
    expect(updated.bodyHtml).not.toContain("iframe");
  });

  it("404s on an unknown id and 409s (archived) on a patch to an archived template", async () => {
    await expect(updateTemplate(handle.db, UNKNOWN_ID, { name: "x" })).rejects.toThrow(NotFoundError);
    await expect(getTemplate(handle.db, UNKNOWN_ID)).rejects.toThrow(NotFoundError);

    const created = await createTemplate(handle.db, { name: "Intro", bodyHtml: "<p>Body</p>" });
    await archiveTemplate(handle.db, created.id);
    await expect(updateTemplate(handle.db, created.id, { name: "x" })).rejects.toThrow(ArchivedError);
  });

  it("archives out of the default list and unarchives back into it, idempotently", async () => {
    const created = await createTemplate(handle.db, { name: "Intro", bodyHtml: "<p>Body</p>" });

    const archived = await archiveTemplate(handle.db, created.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(await listTemplates(handle.db)).toHaveLength(0);
    expect((await listTemplates(handle.db, { archived: true })).map((t) => t.id)).toEqual([created.id]);
    // Second archive is a no-op that returns the row as-is rather than erroring.
    expect((await archiveTemplate(handle.db, created.id)).id).toBe(created.id);

    const restored = await unarchiveTemplate(handle.db, created.id);
    expect(restored.archivedAt).toBeNull();
    expect((await listTemplates(handle.db)).map((t) => t.id)).toEqual([created.id]);

    await expect(archiveTemplate(handle.db, UNKNOWN_ID)).rejects.toThrow(NotFoundError);
  });
});
