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
// server than this plugin. There is no other way to pair.
//
// Usage:
//   node login.mjs start [project-url-or-id]
//   node login.mjs status
import os from 'node:os';
import { getCredentialForDir } from '../lib/credentials.mjs';
import { desktopPair, desktopOutcomeMessage, exchangePairingCode, withCancellation } from '../lib/pairing.mjs';

// Must match mcp/index.mjs — this is the host a NEW pairing is created
// against. Production by default so a fresh install works unconfigured;
// set LITERATI_SERVER_URL for local development (see README.md).
const DEFAULT_SERVER_URL = process.env.LITERATI_SERVER_URL || 'https://api.literati.ai';
// Only Claude Code's /literati:login runs this script (labels only — see
// clientHeaders in mcp/index.mjs).
const CLIENT_HEADERS = { 'X-Literati-Client': 'claude-code' };

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

function loggedIn(projectName) {
  console.log(
    `Logged in to Literati project "${projectName}". This directory (and subdirectories) now resolve that project's credentials.`,
  );
}

async function start(projectUrl) {
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
  // Every other outcome ends the attempt: pairing needs the desktop app, and
  // there is no fallback.
  return fail(desktopOutcomeMessage(desktop, 'run `login.mjs start` again'));
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
else if (cmd === 'status') status();
else fail('Usage: login.mjs <start [project-url] | status>');
