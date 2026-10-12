#!/usr/bin/env node
// Pairing CLI: pairs a working directory with a Literati project WITHOUT
// needing the MCP server to be registered/connected yet (the /literati:login
// command drives this via Bash in the very first session, before the
// user-scope `literati` MCP server has been registered or loaded).
//
// Mirrors the literati_login / literati_login_code MCP tools in
// mcp/index.mjs, which remain the preferred path once the server is live
// (mid-session re-pairing). Each invocation is a fresh process, so the
// in-flight pairing request is persisted to ~/.literati/pairing-pending.json
// between `start` and `code`.
//
// `start` pairs through the Literati desktop app (the user picks the project
// there and this command blocks — up to ~3 min — until they accept) and fails
// when there is no usable app. The pairing-code flow, which needs the project
// URL, is only used when the app is connected to a different server (or with
// LITERATI_DESKTOP_PAIR=0).
//
// Usage:
//   node login.mjs start [project-url-or-id]
//   node login.mjs code <one-time-code>
import os from 'node:os';
import {
  getCredentialForDir,
  savePendingPairing,
  loadPendingPairing,
  clearPendingPairing,
} from '../lib/credentials.mjs';
import {
  desktopPair,
  desktopOutcomeMessage,
  desktopFallbackNote,
  exchangePairingCode,
  withCancellation,
} from '../lib/pairing.mjs';

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
    // A code-flow request left over from an earlier attempt is now moot.
    clearPendingPairing();
    return loggedIn(r.body.projectName);
  }
  // Every other outcome ends the attempt — including no usable app: pairing
  // needs the desktop app, so there is no silent switch to the code flow.
  if (desktop.kind !== 'disabled' && desktop.kind !== 'server_mismatch') {
    return fail(desktopOutcomeMessage(desktop, 'run `login.mjs start` again'));
  }

  // Pairing-code flow, which needs the project up front.
  const note = desktopFallbackNote(desktop, serverUrl);
  if (!projectUrl) {
    return fail([note, 'Ask the user for their Literati project URL, then run: login.mjs start <project-url-or-id>'].join('\n'));
  }
  let res;
  try {
    res = await fetch(`${serverUrl}/cli/pairing/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CLIENT_HEADERS },
      body: JSON.stringify({ project: projectUrl, requesterLabel }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return fail(`Could not reach the Literati server at ${serverUrl}: ${err.message}`);
  }
  if (res.status === 404) {
    return fail('Literati could not find that project. Double-check the project URL.');
  }
  if (!res.ok) return fail(`Pairing request failed: HTTP ${res.status}`);
  const body = await res.json();
  savePendingPairing({ requestId: body.requestId, serverUrl, cwd: process.cwd() });
  console.log(
    [
      note,
      'Pairing request sent. Tell the user to:',
      '  1. Open the project page in the Literati web app (the URL they gave you).',
      '  2. Approve the pairing request prompt that appears there.',
      '  3. Copy the one-time code Literati shows and paste it here.',
      'Then run: login.mjs code <one-time-code>',
      'The request expires in 10 minutes.',
    ].join('\n'),
  );
}

async function code(oneTimeCode) {
  if (!oneTimeCode) return fail('Usage: login.mjs code <one-time-code>');
  const pending = loadPendingPairing();
  if (!pending) {
    return fail('No pairing in progress — run `login.mjs start <project-url>` first.');
  }
  const r = await exchangePairingCode({
    serverUrl: pending.serverUrl,
    requestId: pending.requestId,
    code: oneTimeCode,
    cwd: pending.cwd ?? process.cwd(),
    headers: CLIENT_HEADERS,
  });
  if (r.reason === 'network') return fail(r.message);
  if (r.reason === 'invalid_code') return fail('That code is not correct — re-check it and try again.');
  if (!r.ok) {
    // Terminal: drop the dead request so it can't be resurrected later.
    clearPendingPairing();
    return fail(
      'Pairing could not be completed (expired, denied, or too many attempts). Start over with `login.mjs start`.',
    );
  }
  clearPendingPairing();
  loggedIn(r.body.projectName);
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
else if (cmd === 'code') await code(arg);
else if (cmd === 'status') status();
else fail('Usage: login.mjs <start [project-url] | code <one-time-code> | status>');
