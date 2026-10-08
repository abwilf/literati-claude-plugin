#!/usr/bin/env node
// Literati MCP server (stdio): proxies Literati's agent tools to Claude Code
// and Codex.
//
// Two states:
//   - Not logged in: only `literati_login` / `literati_login_code` are
//     exposed; every other capability tells the model to run the login flow.
//   - Logged in (~/.literati/credentials.json has a default project): the
//     server-side tool list (GET /mcp-agent/tools) is exposed 1:1; calls
//     proxy to POST /mcp-agent/tools/execute with the paired bearer token.
//
// Login: literati_login first tries the Literati desktop app (the user picks
// the project there and nothing needs pasting). Without the app it falls back
// to the two-tool code flow — MCP tools cannot prompt the user, so the model
// relays the one-time code from literati_login to literati_login_code.
import os from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  getCredentialForDir,
  savePendingPairing,
  loadPendingPairing,
  clearPendingPairing,
  isPairingFresh,
} from '../lib/credentials.mjs';
// Snapshot of the server's tool list (scripts/snapshot-tool-catalog.mjs).
import TOOL_CATALOG from './tool-catalog.json' with { type: 'json' };
import {
  desktopPair,
  desktopOutcomeMessage,
  desktopFallbackNote,
  exchangePairingCode,
  withCancellation,
} from '../lib/pairing.mjs';

// Claude Code and Codex launch stdio MCP servers (user-scope registrations
// included) in the session's working directory, so cwd-bound credentials resolve the
// right project per repo. No binding → logged out (no machine-wide fallback).
const activeCredential = () => getCredentialForDir(process.cwd());

// Production by default: an installed plugin must work with no configuration.
// A localhost default silently pointed every fresh install at the user's own
// machine, where pairing fails with a bare connection error that gives no hint
// of the cause. Override with LITERATI_SERVER_URL for local development —
// see README.md. Note the host is only consulted when a directory is FIRST
// paired; after that it is stored per-directory in credentials.json, so the
// env var is not needed again for an already-paired directory.
const DEFAULT_SERVER_URL = process.env.LITERATI_SERVER_URL || 'https://api.literati.ai';
const EXECUTE_TIMEOUT_MS = 9 * 60_000; // compile can be slow

const LOGIN_TOOL = {
  name: 'literati_login',
  description:
    "Pair this folder with a Literati project. Call this whenever the user asks to connect or log in to Literati, or gives a Literati project URL (…/project/<id>) — pair with this tool rather than fetching or curling the URL to connect (opening it in the user's browser for them is fine). If the Literati desktop app is installed it opens a project picker there; otherwise it needs a project URL/slug and uses a pairing code. Do not ask for a project URL up front — call this with none unless the user already gave one. BEFORE calling, tell the user: \"If you have the Literati desktop app, a window will open — pick the project and click Accept.\" The call waits (up to ~3 minutes) for them to accept in the app. If the result says it needs a project URL, ask the user for it and call again with it.",
  inputSchema: {
    type: 'object',
    properties: {
      project_url: {
        type: 'string',
        description: 'Optional. The Literati project URL (https://literati.ai/projects/<id>) or bare project id/slug. Preselects the project in the desktop app; required only for the pairing-code fallback.',
      },
    },
    additionalProperties: false,
  },
};

const LOGIN_CODE_TOOL = {
  name: 'literati_login_code',
  description:
    'Complete Literati pairing. After the user approves the request in the Literati web app they are shown a one-time code — ask them for it and call this tool with it.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'The one-time pairing code shown in Literati.' },
    },
    required: ['code'],
    additionalProperties: false,
  },
};

/** In-flight pairing started by literati_login in this process. */
let pendingPairing = null; // { requestId, serverUrl }
/** Cached remote tool list for the current credential. */
let remoteTools = null;

// Shown when logged out or the server was unreachable at startup. The MCP
// SDK only reads `instructions` once (initialize handshake), so the full
// server-authored guidance can't be swapped in post-login — this fallback
// carries the safety-critical rules; the next session gets the real text.
const FALLBACK_INSTRUCTIONS = [
  'Literati manages LaTeX research projects with server-side files and a paper library.',
  "When the user gives a Literati project URL or asks to connect Literati, pair by calling literati_login (with the URL if given) — don't fetch or curl the URL to connect (opening it in the user's browser for them is fine). If Literati tools are missing or a Literati tool fails with \"Not logged in\", pair the same way (no project URL needed up front if the user has the Literati desktop app).",
  'NEVER hand-edit .bib bibliography files — add references with the add_paper tool (hand-written BibTeX risks hallucinated citations); .bib edits require explicit in-app user approval.',
  'After editing .tex/.bib/.sty files, run the compile tool and fix errors before finishing.',
  'Only use stage_changes / commit_changes when the user explicitly asks.',
].join('\n');

function text(s, isError = false) {
  return { content: [{ type: 'text', text: s }], isError };
}

// Set once the MCP server exists. The startup tool fetch below runs before
// it (and before the client has introduced itself), so it goes out without a
// client header.
let mcpServer = null;

/** Which known client is connected — from its MCP `initialize` clientInfo. */
function clientKind() {
  const name = mcpServer?.getClientVersion()?.name ?? '';
  if (name.startsWith('codex')) return 'codex'; // Codex sends `codex-mcp-client`
  if (name === 'claude-code') return 'claude-code';
  return null;
}

/** Tells Literati which client is calling (pairing prompt label, telemetry).
 * Self-reported, so the server uses it for labels only — never authorization. */
function clientHeaders() {
  const kind = clientKind();
  return kind ? { 'X-Literati-Client': kind } : {};
}

async function api(cred, path, init = {}) {
  const res = await fetch(`${cred.serverUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cred.token}`,
      ...clientHeaders(),
      ...(init.headers ?? {}),
    },
  });
  return res;
}

async function fetchToolsAndInstructions(signal) {
  const cred = activeCredential();
  if (!cred) return null;
  try {
    const res = await api(cred, '/mcp-agent/tools', { signal });
    if (!res.ok) return null;
    const body = await res.json();
    return {
      tools: Array.isArray(body.tools) ? body.tools : null,
      instructions: typeof body.instructions === 'string' ? body.instructions : null,
    };
  } catch {
    return null;
  }
}

// Bounded: tools/list waits on this, and a server that accepts the connection
// but never answers would otherwise stall the client's startup.
async function fetchRemoteTools() {
  const startup = await fetchToolsAndInstructions(AbortSignal.timeout(5000));
  return startup?.tools ?? null;
}

// Instructions are constructor-only in the MCP SDK (read once during the
// initialize handshake), so fetch them BEFORE constructing the server —
// bounded to 2s so a down server never blocks the client's startup.
const startup = activeCredential()
  ? await fetchToolsAndInstructions(AbortSignal.timeout(2000))
  : null;
remoteTools = startup?.tools ?? null;

const server = new Server(
  { name: 'literati', version: '0.1.0' },
  {
    capabilities: { tools: { listChanged: true } },
    instructions: startup?.instructions ?? FALLBACK_INSTRUCTIONS,
  },
);
mcpServer = server;

// Codex lists tools once per session and ignores tools/list_changed, so after
// a mid-session login it would keep only the two login tools until a restart.
// For such clients, advertise the catalog snapshot up front: until the folder
// is paired every call answers "not logged in", and once it is the same names
// just work (handleRemoteTool re-reads the credential on every call). Claude
// Code keeps the two-tool list until login — it refreshes on list_changed.
function listsToolsOnce() {
  return clientKind() === 'codex';
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!remoteTools) remoteTools = await fetchRemoteTools();
  const tools = [LOGIN_TOOL, LOGIN_CODE_TOOL];
  for (const t of remoteTools ?? (listsToolsOnce() ? TOOL_CATALOG.tools : [])) {
    tools.push({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    });
  }
  return { tools };
});

async function handleLogin(args, signal) {
  const projectUrl = String(args?.project_url ?? '').trim();
  const serverUrl = DEFAULT_SERVER_URL;
  const requesterLabel = `${os.userInfo().username}@${os.hostname()}`;

  // Desktop app first: the user picks the project there; nothing to paste.
  // A cancelled tool call (or the server being killed) withdraws the request.
  const desktop = await withCancellation(
    (sig) =>
      desktopPair({
        serverUrl,
        cwd: process.cwd(),
        requesterLabel,
        project: projectUrl || undefined,
        client: clientKind(),
        signal: sig,
      }),
    signal,
  );
  if (desktop.kind === 'approved') {
    const r = await exchangePairingCode({
      serverUrl,
      requestId: desktop.requestId,
      code: desktop.code,
      cwd: process.cwd(),
      headers: clientHeaders(),
    });
    if (!r.ok) return text(`${r.message} Call literati_login again to retry.`, true);
    return finishLogin(r.body);
  }
  if (desktop.kind !== 'unavailable' && desktop.kind !== 'server_mismatch') {
    return text(desktopOutcomeMessage(desktop, 'call literati_login again'), true);
  }

  // Fallback: pairing-code flow, which needs the project up front.
  const note = desktopFallbackNote(desktop, serverUrl);
  if (!projectUrl) {
    return text(
      [
        note || 'The Literati desktop app is not available on this machine, so pairing uses a one-time code instead.',
        'Ask the user for their Literati project URL (https://literati.ai/projects/<id>, or a bare project id), then call literati_login again with project_url.',
      ].join('\n'),
      true,
    );
  }
  let res;
  try {
    res = await fetch(`${serverUrl}/cli/pairing/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...clientHeaders() },
      body: JSON.stringify({ project: projectUrl, requesterLabel }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return text(`Could not reach the Literati server at ${serverUrl}: ${err.message}`, true);
  }
  if (res.status === 404) {
    return text('Literati could not find that project. Double-check the project URL.', true);
  }
  if (!res.ok) {
    return text(`Pairing request failed: HTTP ${res.status}`, true);
  }
  const body = await res.json();
  pendingPairing = { requestId: body.requestId, serverUrl, cwd: process.cwd(), createdAt: new Date().toISOString() };
  // Best-effort: if the disk write fails this session can still finish the
  // pairing from memory, and the request already exists server-side either way.
  savePendingPairing(pendingPairing);
  return text(
    [
      ...(note ? [note] : []),
      'Pairing request sent.',
      'Tell the user to:',
      '  1. Open the project page in the Literati web app (the URL they gave you).',
      '  2. Approve the pairing request prompt that appears there.',
      '  3. Copy the one-time code Literati shows and paste it here.',
      'When the user gives you the code, call literati_login_code with it.',
      'The request expires in 10 minutes.',
    ].join('\n'),
  );
}

async function handleLoginCode(args) {
  const code = String(args?.code ?? '').trim();
  if (!code) return text('code is required.', true);
  // Prefer the on-disk record: it is rewritten by every `literati_login` and
  // every `login.mjs start`, in this process or another, so it is the
  // authoritative one. In-memory is only a fallback for when the disk write
  // failed, and is TTL-checked the same way.
  const pending = loadPendingPairing() ?? (isPairingFresh(pendingPairing) ? pendingPairing : null);
  if (!pending) {
    return text('No pairing in progress — call literati_login first.', true);
  }
  // Bind to the directory the pairing was STARTED from, not wherever the code
  // was pasted — finishing from another directory must not pair that one.
  const r = await exchangePairingCode({
    serverUrl: pending.serverUrl,
    requestId: pending.requestId,
    code,
    cwd: pending.cwd ?? process.cwd(),
    headers: clientHeaders(),
  });
  if (r.reason === 'network') return text(r.message, true);
  if (r.reason === 'invalid_code') {
    return text('That code is not correct — ask the user to re-check it and try again.', true);
  }
  if (!r.ok) {
    // Terminal: the request is dead server-side, so drop it. Leaving it would
    // keep serving a doomed request and make "no pairing in progress"
    // permanently unreachable.
    pendingPairing = null;
    clearPendingPairing();
    return text(
      'Pairing could not be completed (expired, denied, or too many attempts). Start over with literati_login.',
      true,
    );
  }
  pendingPairing = null;
  clearPendingPairing();
  return finishLogin(r.body);
}

/** Credential is saved: load the project's tools and report success. */
async function finishLogin(body) {
  remoteTools = await fetchRemoteTools();
  try {
    await server.sendToolListChanged();
  } catch {
    /* client may not support listChanged */
  }
  const toolCount = remoteTools?.length ?? 0;
  // A client that lists tools once already has the catalog: say so plainly,
  // or the model goes looking for "newly available" tools and gives up.
  let next;
  if (listsToolsOnce()) {
    // Name a tool the client was actually given, so the example never goes stale.
    const example = (remoteTools ?? TOOL_CATALOG.tools)[0]?.name;
    next = `The Literati tools are ready — call them directly${example ? ` (e.g. ${example})` : ''}.`;
  }
  else if (toolCount > 0) next = `${toolCount} Literati tools are now available.`;
  else next = 'If Literati tools do not appear, reconnect the MCP server (or restart your client).';
  return text(`Logged in to Literati project "${body.projectName}". ${next}`);
}

async function handleRemoteTool(name, args) {
  const cred = activeCredential();
  if (!cred) {
    return text(
      'Not logged in to Literati. Call literati_login to pair this directory (it asks for a project URL only if the Literati desktop app is unavailable).',
      true,
    );
  }
  let res;
  try {
    res = await api(cred, '/mcp-agent/tools/execute', {
      method: 'POST',
      body: JSON.stringify({ toolName: name, args: args ?? {} }),
      signal: AbortSignal.timeout(EXECUTE_TIMEOUT_MS),
    });
  } catch (err) {
    return text(`Literati request failed: ${err.message}`, true);
  }
  if (res.status === 401) {
    return text(
      'Your Literati login has expired or been revoked — ask the user to re-pair via literati_login.',
      true,
    );
  }
  if (res.status === 202) {
    // Server-gated call (e.g. a .bib edit awaiting in-app approval). The
    // wait is segmented — the server holds each /wait call <30s (ALB idle
    // limit) and we loop until resolved or our own deadline.
    const pending = await res.json().catch(() => ({}));
    if (pending?.approvalId) return awaitApproval(cred, pending);
    return text('Literati returned an unexpected pending response.', true);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return text(`Literati error (HTTP ${res.status}): ${body?.error ?? 'unknown'}`, true);
  }
  const body = await res.json();
  return renderExecuteResult(body);
}

const APPROVAL_DEADLINE_MS = 4.5 * 60_000; // inside EXECUTE_TIMEOUT_MS

async function awaitApproval(cred, pending) {
  const deadline = Date.now() + APPROVAL_DEADLINE_MS;
  while (Date.now() < deadline) {
    let res;
    try {
      res = await api(cred, `/mcp-agent/approvals/${pending.approvalId}/wait`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return text(`Literati approval wait failed: ${err.message}`, true);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return text(`Literati error (HTTP ${res.status}): ${body?.error ?? 'unknown'}`, true);
    }
    const body = await res.json();
    if (body?.status === 'pending') continue;
    return renderExecuteResult(body);
  }
  return text(
    'Timed out waiting for in-app approval. Ask the user to open the project page in the Literati web app and approve (or use add_paper for citations instead).',
    true,
  );
}

function renderExecuteResult(body) {
  const parts = [];
  if (body.result) parts.push(body.result);
  if (body.error) parts.push(`Error: ${body.error}`);
  if (body.compileResult) {
    parts.push(
      body.compileResult.success
        ? 'Compile succeeded.'
        : `Compile finished with ${body.compileResult.errorCount} error(s).`,
    );
  }
  return text(parts.join('\n\n') || '(no output)', body.success === false);
}

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args } = req.params;
  if (name === 'literati_login') return handleLogin(args, extra?.signal);
  if (name === 'literati_login_code') return handleLoginCode(args);
  return handleRemoteTool(name, args);
});

const transport = new StdioServerTransport();
await server.connect(transport);
