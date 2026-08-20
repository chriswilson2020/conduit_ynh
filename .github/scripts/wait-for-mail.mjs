// Block until every mail server the integration suite needs is answering at
// the PROTOCOL level, not just at the TCP one.
//
// The distinction matters here: `docker run -p` publishes the port through a
// proxy that starts listening immediately, so a plain TCP connect succeeds
// long before Dovecot itself is up -- a test suite racing container boot would
// see connection resets rather than a clean "not ready yet". So each IMAP and
// SMTP target has to produce its greeting line, and Mailpit's API has to
// answer, before this exits.
//
// Run with plain `node`; no dependencies, no build step.

import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

const DEADLINE_MS = 120_000;
const ATTEMPT_TIMEOUT_MS = 4_000;
const RETRY_DELAY_MS = 1_000;

const host = process.env.MAIL_IT_IMAP_HOST ?? "127.0.0.1";
const smtpHost = process.env.MAIL_IT_SMTP_HOST ?? "127.0.0.1";
const mailpitUrl = process.env.MAIL_IT_MAILPIT_URL ?? "http://127.0.0.1:8025";

const greeters = [
  {
    name: "Dovecot IMAPS",
    host,
    port: Number(process.env.MAIL_IT_IMAP_PORT ?? 993),
    tls: true,
    expect: /^\* (OK|PREAUTH)/,
  },
  {
    name: "Dovecot IMAP with STARTTLS",
    host,
    port: Number(process.env.MAIL_IT_IMAP_STARTTLS_PORT ?? 1144),
    tls: false,
    expect: /^\* (OK|PREAUTH)/,
  },
  {
    name: "Dovecot IMAP without STARTTLS",
    host,
    port: Number(process.env.MAIL_IT_IMAP_NO_TLS_PORT ?? 1143),
    tls: false,
    expect: /^\* (OK|PREAUTH)/,
  },
  {
    name: "Mailpit SMTP",
    host: smtpHost,
    port: Number(process.env.MAIL_IT_SMTP_PORT ?? 1025),
    tls: false,
    expect: /^220 /,
  },
];

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** The first line the server sends, or a rejection. */
function greeting(target) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, line) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(line);
    };
    const timer = setTimeout(() => { finish(new Error("timed out waiting for a greeting")); }, ATTEMPT_TIMEOUT_MS);
    const options = target.tls
      ? { host: target.host, port: target.port, rejectUnauthorized: false, servername: "localhost" }
      : { host: target.host, port: target.port };
    const socket = target.tls ? tlsConnect(options) : netConnect(options);
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline !== -1) finish(null, buffered.slice(0, newline).trim());
    });
    socket.on("error", (error) => { finish(error); });
    socket.on("close", () => { finish(new Error("closed before a greeting arrived")); });
  });
}

async function mailpitReady() {
  const response = await fetch(`${mailpitUrl}/api/v1/info`);
  if (!response.ok) throw new Error(`Mailpit API answered ${response.status}`);
  return `HTTP ${response.status}`;
}

async function waitFor(name, attempt) {
  const started = Date.now();
  let last = "never attempted";
  while (Date.now() - started < DEADLINE_MS) {
    try {
      const detail = await attempt();
      console.log(`ready: ${name} (${detail})`);
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(RETRY_DELAY_MS);
  }
  throw new Error(`${name} never became ready: ${last}`);
}

for (const target of greeters) {
  await waitFor(`${target.name} on ${target.host}:${target.port}`, async () => {
    const line = await greeting(target);
    if (!target.expect.test(line)) throw new Error(`unexpected greeting: ${line}`);
    return line;
  });
}

await waitFor(`Mailpit API at ${mailpitUrl}`, mailpitReady);
