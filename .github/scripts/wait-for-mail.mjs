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
// It also asserts the ONE PROPERTY the two-Dovecot split exists for: 1144
// advertises STARTTLS and 1143 does not. That is what lets the suite prove
// that requiring STARTTLS fails against a server which does not offer it
// rather than quietly continuing in the clear -- and if a config edit ever
// made both instances agree, every such case would still pass while testing
// nothing. Cheap to check here, and a fixture regression then fails in this
// step with one line saying so, instead of silently hollowing out the suite.
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
    starttls: true,
  },
  {
    name: "Dovecot IMAP without STARTTLS",
    host,
    port: Number(process.env.MAIL_IT_IMAP_NO_TLS_PORT ?? 1143),
    tls: false,
    expect: /^\* (OK|PREAUTH)/,
    starttls: false,
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

/**
 * The capability names in an IMAP line, or null if it carries none. Covers
 * both places a server may put them: inside the greeting's response code
 * (`* OK [CAPABILITY IMAP4rev1 STARTTLS] ready.`) and in the untagged reply
 * to an explicit CAPABILITY command (`* CAPABILITY IMAP4rev1 STARTTLS`).
 */
function capabilityNames(line) {
  const inGreeting = /\[CAPABILITY ([^\]]*)\]/i.exec(line);
  if (inGreeting !== null) return inGreeting[1].trim().toUpperCase().split(/\s+/);
  const untagged = /^\* CAPABILITY (.*)$/i.exec(line.trim());
  if (untagged !== null) return untagged[1].trim().toUpperCase().split(/\s+/);
  return null;
}

/**
 * The first line the server sends and, for a target that cares, the
 * capabilities it advertises before login -- or a rejection.
 *
 * Dovecot puts its capability list in the greeting itself, so this normally
 * costs no extra round trip; the CAPABILITY command below is the fallback for
 * a server (or a future config) that does not, so that "no STARTTLS
 * advertised" always means the real thing rather than "not in the greeting".
 */
function probe(target) {
  const wantsCapabilities = target.starttls !== undefined;
  return new Promise((resolve, reject) => {
    let settled = false;
    let line = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
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
      if (line === null) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) return;
        line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        const advertised = wantsCapabilities ? capabilityNames(line) : null;
        if (!wantsCapabilities || advertised !== null) {
          finish(null, { line, capabilities: advertised });
          return;
        }
        socket.write("C1 CAPABILITY\r\n");
        return;
      }
      for (const reply of buffered.split("\n")) {
        const advertised = capabilityNames(reply);
        if (advertised !== null) finish(null, { line, capabilities: advertised });
      }
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

/** What each target advertised on the attempt that finally succeeded. */
const advertised = new Map();

for (const target of greeters) {
  await waitFor(`${target.name} on ${target.host}:${target.port}`, async () => {
    const { line, capabilities } = await probe(target);
    if (!target.expect.test(line)) throw new Error(`unexpected greeting: ${line}`);
    advertised.set(target, capabilities);
    return line;
  });
}

// Not inside waitFor: a mismatch here is a broken fixture, not a server that
// has yet to finish booting, and retrying it for two minutes would only bury
// the message.
for (const target of greeters.filter((entry) => entry.starttls !== undefined)) {
  const capabilities = advertised.get(target);
  const advertises = (capabilities ?? []).includes("STARTTLS");
  if (advertises !== target.starttls) {
    throw new Error(
      `${target.name} on ${target.host}:${target.port} ${advertises ? "advertises" : "does not advertise"}`
      + ` STARTTLS, but the fixture requires that it ${target.starttls ? "does" : "does not"}`
      + ` (capabilities: ${(capabilities ?? []).join(" ") || "none reported"})`,
    );
  }
  console.log(`ok: ${target.name} ${advertises ? "advertises" : "does not advertise"} STARTTLS, as required`);
}

await waitFor(`Mailpit API at ${mailpitUrl}`, mailpitReady);
