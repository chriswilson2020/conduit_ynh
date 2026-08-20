import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "./config.js";
import { createDatabase, runMigrations } from "./db/client.js";
import { buildApp } from "./app.js";
import { createImapClientFactory, createSmtpTransportFactory } from "./services/mail-imapflow.js";
import { startSyncManager, type SyncManager } from "./services/mail-sync.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = parseConfig(process.env);

  // The key is read lazily (mail-crypto.ts's loadMailKey), only when a
  // mail-account route actually needs to encrypt/decrypt credentials, and a
  // missing file must never stop the CRM from serving -- it degrades to a
  // 503 on mail-account routes (see the Phase 4 spec's "Key handling"
  // section). This is the one place that promise becomes visible at boot,
  // logged once, so an operator sees it in the startup log rather than
  // discovering it the first time someone opens Settings -> Mail.
  //
  // No dedicated unit test: main() below runs unconditionally on import
  // (nothing guards it behind an entry-point check), so a test importing
  // this module would attempt a real database connection rather than
  // exercising just this line. Making that seam-testable is a server.ts
  // restructuring, out of scope for this check.
  if (!existsSync(config.mailKeyPath)) {
    console.warn(
      `mail.key not found at ${config.mailKeyPath}; mail-account routes will return 503 until it exists -- the install/upgrade scripts provision it`,
    );
  }

  const { db, close } = createDatabase(config.databaseUrl);

  await runMigrations(db);

  // Assigned once the manager is started, below. Routes registered by
  // buildApp read it through the getter they are given, at request time, so
  // this being null right now is not a problem to design around -- it is the
  // state the app genuinely has until the server is listening.
  let syncManager: SyncManager | null = null;

  // Both mail seams are built HERE, the composition root, from parsed config:
  // how a connection is configured (TLS verification in particular) is a
  // deployment decision, and nothing under routes/ or services/ should be
  // reading the environment to discover it.
  const transportFactory = createSmtpTransportFactory({
    rejectUnauthorized: config.mailTlsRejectUnauthorized,
  });

  const app = await buildApp({
    config,
    db,
    dataDir: config.dataDir,
    // server.js is staged one level under the release root (<root>/server/server.js),
    // and the built SPA sits alongside it at <root>/web -- one ".." back up to
    // <root>, then into web. (Compare db/client.ts's migrationsFolder(), which needs
    // two: server/db/client.js is nested one level deeper than server/server.js.)
    webRoot: process.env.WEB_ROOT ?? path.join(here, "..", "web"),
    mail: { syncManager: () => syncManager, transportFactory },
  });

  // Loopback only. nginx is the sole ingress, and that is what makes the
  // SSOwat identity headers trustworthy.
  await app.listen({ port: config.port, host: "127.0.0.1" });
  app.log.info(`Conduit ${config.version} listening on 127.0.0.1:${config.port}`);

  // After listen, deliberately: the sync engine opens outbound IMAP
  // connections and writes to the database, and none of that should be
  // competing with boot. It is also not allowed to prevent boot -- a mail
  // server being unreachable must never stop the CRM from serving -- which
  // is why the manager's own start() only reads account rows, and every
  // connection attempt happens inside an AccountSync's guarded loop.
  //
  // `clientFactory` is what makes mail sync live: the manager reads each
  // account row and its decrypted credentials itself, and asks this factory
  // for one FRESH imapflow client per connection attempt (mail-imap.ts's
  // lifecycle contract). startSyncManager still starts nothing under
  // NODE_ENV=test.
  syncManager = await startSyncManager({
    db,
    dataDir: config.dataDir,
    mailKeyPath: config.mailKeyPath,
    nodeEnv: config.nodeEnv,
    clientFactory: createImapClientFactory({
      rejectUnauthorized: config.mailTlsRejectUnauthorized,
    }),
    logger: {
      info: (details, message) => { app.log.info(details, message); },
      warn: (details, message) => { app.log.warn(details, message); },
      error: (details, message) => { app.log.error(details, message); },
    },
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void (async () => {
        app.log.info(`Received ${signal}, shutting down`);
        // Sync first: it holds IMAP connections and database work of its
        // own, and stopping it before the pool closes is what keeps a
        // shutdown from racing a pass mid-transaction.
        if (syncManager !== null) await syncManager.stop();
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
