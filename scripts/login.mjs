#!/usr/bin/env node
// Pairing CLI: pairs a working directory with a Literati project WITHOUT
// needing the MCP server to be registered/connected yet (the /literati:login
// command drives this via Bash in the very first session, before the
// user-scope `literati` MCP server has been registered or loaded).
//
// Mirrors the literati_login MCP tool in mcp/index.mjs, which remains the
// preferred path once the server is live (mid-session re-pairing).
//
// `start` pairs through the Literati desktop app (the user picks the project
// there and this command blocks — up to ~3 min — until they accept) and fails
// when there is no usable app: not installed, signed out, or on a different
// server than this plugin — naming the web app's pairing page as the way
// around it. `complete <code>` is that way: the user minted the code on the
// page and pasted it; it is exchanged on its own, nothing opens.
//
// Usage:
//   node login.mjs start [project-url-or-id | code]
//   node login.mjs complete <code>
//   node login.mjs status
import os from 'node:os';
import { getCredentialForDir } from '../lib/credentials.mjs';
import {
  desktopPair,
  desktopOutcomeMessage,
  exchangePairingCode,
  fetchPairPageUrl,
  isPairingCode,
  withCancellation,
} from '../lib/pairing.mjs';

// Must match mcp/index.mjs — this is the host a NEW pairing is created
// against. Production by default so a fresh install works unconfigured;
// set LITERATI_SERVER_URL for local development (see README.md).
const DEFAULT_SERVER_URL = process.env.LITERATI_SERVER_URL || 'https://api.literati.ai';
// Only Claude Code's /literati:login runs this script (labels only — see
// clientHeaders in mcp/index.mjs).
const CLIENT_HEADERS = { 'X-Literati-Client': 'claude-code' };

const USAGE = 'Usage: login.mjs <start [project-url] | complete <code> | status>';
const PASTE = 'run `login.mjs complete <code>` here';

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

const pairPageOr = async (serverUrl) => (await fetchPairPageUrl(serverUrl)) ?? "the Literati web app's pairing page (/pair)";

function loggedIn(projectName) {
  console.log(
    `Logged in to Literati project "${projectName}". This directory (and subdirectories) now resolve that project's credentials.`,
  );
}

async function start(projectUrl) {
  // A pasted code where the project URL goes: the user already did the web
  // pairing page's part, so there is nothing to ask the desktop app.
  if (projectUrl && isPairingCode(projectUrl)) return complete(projectUrl);
  const serverUrl = DEFAULT_SERVER_URL;
  const requesterLabel = `${os.userInfo().username}@${os.hostname()}`;

  // Desktop app first: the user picks the project there; nothing to paste.
  // Ctrl-C / SIGTERM while waiting withdraws the request in the app.
  const desktop = await withCancellation((signal) =>
    desktopPair({
      serverUrl,
      cwd: process.cwd(),
      requesterLabel,
      project: projectUrl,
      client: 'claude-code',
      signal,
    }),
  );
  if (desktop.kind === 'approved') {
    const r = await exchangePairingCode({
      serverUrl,
      requestId: desktop.requestId,
      code: desktop.code,
      cwd: process.cwd(),
      headers: CLIENT_HEADERS,
    });
    if (!r.ok) return fail(`${r.message} Run \`login.mjs start\` again to retry.`);
    return loggedIn(r.body.projectName);
  }
  // Every other outcome ends the attempt. Without a usable app the message
  // also names the pairing page, so the user can come back with a code.
  const byCode =
    desktop.kind === 'unavailable' || desktop.kind === 'server_mismatch'
      ? { pairUrl: await fetchPairPageUrl(serverUrl), paste: PASTE }
      : undefined;
  return fail(desktopOutcomeMessage(desktop, 'run `login.mjs start` again', byCode));
}

async function complete(code) {
  if (!code) return fail(USAGE);
  if (!isPairingCode(code)) {
    return fail(
      "That doesn't look like a Literati pairing code (8 letters and digits, e.g. K7QM2XPT). Copy it from the pairing page and try again.",
    );
  }
  const serverUrl = DEFAULT_SERVER_URL;
  const r = await exchangePairingCode({ serverUrl, code, cwd: process.cwd(), headers: CLIENT_HEADERS });
  if (!r.ok) {
    // Unreachable or rate-limited: the code is still good, so say to retry it;
    // anything else means the code is spent and only a new one will do.
    const next =
      r.reason === 'network' || r.reason === 'rate_limited'
        ? `Then ${PASTE} again with the same code.`
        : `Create a new code at ${await pairPageOr(serverUrl)} and ${PASTE} again.`;
    return fail(`${r.message} ${next}`);
  }
  return loggedIn(r.body.projectName);
}

function status() {
  const cred = getCredentialForDir(process.cwd());
  if (cred) {
    console.log(`Paired with Literati project "${cred.projectName}" (server: ${cred.serverUrl}).`);
  } else {
    console.log('This directory is not paired with a Literati project.');
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'start') await start(arg);
else if (cmd === 'complete') await complete(arg);
else if (cmd === 'status') status();
else fail(USAGE);
