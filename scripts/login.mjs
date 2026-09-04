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
// Usage:
//   node login.mjs start <project-url-or-id>
//   node login.mjs code <one-time-code>
import os from 'node:os';
import {
  addProjectCredential,
  getCredentialForDir,
  savePendingPairing,
  loadPendingPairing,
  clearPendingPairing,
} from '../lib/credentials.mjs';

// Must match mcp/index.mjs — this is the host a NEW pairing is created
// against. Production by default so a fresh install works unconfigured;
// set LITERATI_SERVER_URL for local development (see README.md).
const DEFAULT_SERVER_URL = process.env.LITERATI_SERVER_URL || 'https://api.literati.ai';

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

async function start(projectUrl) {
  if (!projectUrl) return fail('Usage: login.mjs start <project-url-or-id>');
  const serverUrl = DEFAULT_SERVER_URL;
  const requesterLabel = `${os.userInfo().username}@${os.hostname()}`;
  let res;
  try {
    res = await fetch(`${serverUrl}/cli/pairing/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      'Pairing request sent. Tell the user to:',
      '  1. Open the project page in the Literati web app (the URL they gave you).',
      '  2. Approve the "Claude Code pairing request" prompt that appears there.',
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
  let res;
  try {
    res = await fetch(`${pending.serverUrl}/cli/pairing/requests/${pending.requestId}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: oneTimeCode }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return fail(`Could not reach the Literati server: ${err.message}`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body?.code === 'PAIRING_INVALID_CODE') {
      return fail('That code is not correct — re-check it and try again.');
    }
    // Terminal: drop the dead request so it can't be resurrected later.
    clearPendingPairing();
    return fail(
      'Pairing could not be completed (expired, denied, or too many attempts). Start over with `login.mjs start`.',
    );
  }
  const body = await res.json();
  addProjectCredential(
    {
      serverUrl: pending.serverUrl,
      token: body.token,
      collectionId: body.collectionId,
      workspaceId: body.workspaceId,
      userId: body.userId,
      projectSlug: body.projectSlug,
      projectName: body.projectName,
    },
    pending.cwd ?? process.cwd(),
  );
  clearPendingPairing();
  console.log(
    `Logged in to Literati project "${body.projectName}". This directory (and subdirectories) now resolve that project's credentials.`,
  );
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
else fail('Usage: login.mjs <start <project-url> | code <one-time-code> | status>');
