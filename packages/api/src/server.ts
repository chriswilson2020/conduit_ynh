import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "./config.js";
import { createDatabase, runMigrations } from "./db/client.js";
import { buildApp } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const { db, close } = createDatabase(config.databaseUrl);

  await runMigrations(db);

  const app = await buildApp({
    config,
    db,
    // server.js is staged one level under the release root (<root>/server/server.js),
    // and the built SPA sits alongside it at <root>/web -- one ".." back up to
    // <root>, then into web. (Compare db/client.ts's migrationsFolder(), which needs
    // two: server/db/client.js is nested one level deeper than server/server.js.)
    webRoot: process.env.WEB_ROOT ?? path.join(here, "..", "web"),
  });

  // Loopback only. nginx is the sole ingress, and that is what makes the
  // SSOwat identity headers trustworthy.
  await app.listen({ port: config.port, host: "127.0.0.1" });
  app.log.info(`Conduit ${config.version} listening on 127.0.0.1:${config.port}`);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void (async () => {
        app.log.info(`Received ${signal}, shutting down`);
        await app.close();
        await close();
        process.exit(0);
      })();
    });
  }
}

main().catch((error: unknown) => {
  console.error("Conduit failed to start:", error);
  process.exit(1);
});
