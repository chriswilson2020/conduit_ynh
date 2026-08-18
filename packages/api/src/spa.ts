import { readFile } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export interface SpaOptions {
  /** Directory holding the built SPA (index.html plus assets/). */
  webRoot: string;
  /** Public mount path, without a trailing slash. "/" for a domain-root install. */
  basePath: string;
}

/**
 * Serve the built SPA: static assets straight from disk, and index.html for any
 * unmatched non-API route so client-side deep links resolve. The __BASE_PATH__
 * placeholder is substituted per request, which is what lets a single build work
 * at any YunoHost install path.
 */
export async function registerSpa(app: FastifyInstance, options: SpaOptions): Promise<void> {
  await app.register(fastifyStatic, {
    root: path.resolve(options.webRoot),
    index: false,
    wildcard: false,
  });

  const indexPath = path.join(path.resolve(options.webRoot), "index.html");

  // <base href> always carries a trailing slash so relative asset URLs resolve
  // against the mount point. basePath itself never has one ("/" stays "/").
  const baseHref = options.basePath === "/" ? "/" : `${options.basePath}/`;

  const sendIndex = async (): Promise<string> => {
    const html = await readFile(indexPath, "utf8");
    return html.replaceAll("__BASE_HREF__", baseHref).replaceAll("__BASE_PATH__", options.basePath);
  };

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({
        error: "not_found",
        message: `No route for ${request.method} ${request.url}`,
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.type("text/html; charset=utf-8").send(await sendIndex());
  });
}
