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
  const webRoot = path.resolve(options.webRoot);

  await app.register(fastifyStatic, {
    root: webRoot,
    index: false,
    wildcard: false,
    // Fix 2 (hotfix v0.4.3): Vite content-hashes every filename under
    // assets/ (see vite.config.ts), so those files are safe to cache
    // forever -- a new release ships under brand-new hashed filenames, it
    // never overwrites an old one in place. This is @fastify/static's own
    // documented pattern for a Vite SPA (see its README's "Managing
    // cache-control headers" section): blanket maxAge/immutable at the
    // plugin level, with index.html carved out separately below.
    //
    // A per-file `setHeaders` hook is NOT an option here: @fastify/static
    // calls it before computing its OWN Cache-Control from these same
    // maxAge/immutable options, then unconditionally applies that computed
    // header afterwards (`reply.headers(headers)` in its pumpSendToReply),
    // clobbering whatever setHeaders set -- there is no per-file override
    // once maxAge/immutable are configured at the plugin level.
    maxAge: "1y",
    immutable: true,
    // wildcard:false (above) makes this plugin enumerate every real file
    // under webRoot at boot and register an exact static route for each one
    // -- index:false only disables the automatic "/" -> index.html mapping,
    // it does NOT stop that per-file route from existing, and it would
    // inherit the blanket immutable settings above like any other file.
    // index.html must never be cached that way (a release could never be
    // seen again), so it's excluded from the enumeration entirely: a
    // request for it here falls through to the not-found handler below,
    // which serves it fresh with Cache-Control: no-cache instead.
    globIgnore: ["index.html"],
  });

  const indexPath = path.join(webRoot, "index.html");

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
    // Fix 2 (hotfix v0.4.3): every "/" and deep-link hit lands here and reads
    // index.html fresh off disk per request already (sendIndex(), above), so
    // a "no-cache" response costs nothing extra -- it just tells the browser
    // to always revalidate rather than serve a stale shell after a release,
    // which used to need a hard refresh to pick up.
    return reply.header("Cache-Control", "no-cache").type("text/html; charset=utf-8").send(await sendIndex());
  });
}
