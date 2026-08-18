import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sseHintSchema, companySchema } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { buildApp } from "../app.js";
import { publish } from "../services/sse.js";
import type { Config } from "../config.js";

const handle = openTestDatabase();

const config: Config = {
  nodeEnv: "test",
  port: 0,
  databaseUrl: "unused-in-tests",
  basePath: "/",
  version: "0.1.0-test",
  devUser: null,
  dataDir: "./data",
  defaultCurrency: "EUR",
};

const authHeaders = {
  "ynh-user": "chris",
  "ynh-user-email": "chris@example.com",
  "ynh-user-fullname": "Chris Wilson",
};

let dataDir: string;

beforeEach(async () => {
  await truncateAll(handle);
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-stream-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
afterAll(async () => {
  await handle.close();
});

/**
 * SSE is fundamentally incompatible with app.inject(), which buffers a whole
 * response before returning it -- a connection that never "completes" would
 * just hang inject forever. A real listener on port 0 (the OS picks a free
 * port) plus the platform fetch client, reading the body as a stream, is the
 * only way to observe frames as they arrive.
 */
async function listen(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = await buildApp({ config, db: handle.db, dataDir });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("expected a bound TCP address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => app.close(),
  };
}

/** Reads whole `\n\n`-terminated SSE frames off a fetch response body reader. */
function frameReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<string> {
      while (!buffer.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended before a full frame arrived");
        buffer += decoder.decode(value, { stream: true });
      }
      const idx = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      return frame;
    },
    cancel: () => reader.cancel(),
  };
}

describe("stream route", () => {
  it("requires auth: 401 with the uniform shape, no connection opened", async () => {
    const { url, close } = await listen();
    try {
      const response = await fetch(`${url}/api/stream`);
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toEqual({
        error: "unauthenticated",
        message: "No Ynh-User header was present on this request",
      });
    } finally {
      await close();
    }
  });

  it("streams a retry preamble, then a published hint as a data frame", async () => {
    const { url, close } = await listen();
    const controller = new AbortController();
    try {
      const response = await fetch(`${url}/api/stream`, {
        headers: authHeaders,
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      if (response.body === null) throw new Error("expected a streamed body");
      const frames = frameReader(response.body);

      expect(await frames.next()).toBe("retry: 3000");

      const hint = { keys: [["companies"], ["company", "11111111-1111-1111-1111-111111111111"]] };
      sseHintSchema.parse(hint); // shape sanity: this is what a real publisher sends
      publish(hint);

      const dataFrame = await frames.next();
      expect(dataFrame.startsWith("data: ")).toBe(true);
      expect(JSON.parse(dataFrame.slice("data: ".length))).toEqual(hint);

      frames.cancel();
    } finally {
      controller.abort();
      await close();
    }
  });

  it("does not starve a normal API request while a stream connection is open", async () => {
    const { url, close } = await listen();
    const controller = new AbortController();
    try {
      const streamResponse = await fetch(`${url}/api/stream`, {
        headers: authHeaders,
        signal: controller.signal,
      });
      expect(streamResponse.status).toBe(200);
      if (streamResponse.body === null) throw new Error("expected a streamed body");
      const frames = frameReader(streamResponse.body);
      expect(await frames.next()).toBe("retry: 3000"); // stream is live before the next request

      const createResponse = await fetch(`${url}/api/companies`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme" }),
      });
      expect(createResponse.status).toBe(201);
      companySchema.parse(await createResponse.json());

      frames.cancel();
    } finally {
      controller.abort();
      await close();
    }
  });
});
