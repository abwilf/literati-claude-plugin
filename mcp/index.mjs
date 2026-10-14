#!/usr/bin/env node
// Literati MCP server (stdio): proxies Literati's agent tools to Claude Code
// and Codex.
//
// Two states:
//   - Not logged in: only `literati_login` is exposed; every other capability
//     tells the model to run the login flow.
//   - Logged in (~/.literati/credentials.json has a default project): the
//     server-side tool list (GET /mcp-agent/tools) is exposed 1:1; calls
//     proxy to POST /mcp-agent/tools/execute with the paired bearer token.
//
// Login: literati_login pairs through the Literati desktop app, and only
// through it — the user picks the project there and nothing needs pasting;
// the app hands back a one-time code that is exchanged for the token. Without
// a usable app (not installed, signed out, or on a different server than this
// plugin) the call fails with a message saying what to fix.
import os from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getCredentialForDir } from '../lib/credentials.mjs';
// Snapshot of the server's tool list (scripts/snapshot-tool-catalog.mjs).
import TOOL_CATALOG from './tool-catalog.json' with { type: 'json' };
import { desktopPair, desktopOutcomeMessage, exchangePairingCode, withCancellation } from '../lib/pairing.mjs';

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
    "Pair this folder with a Literati project. Call this whenever the user asks to connect or log in to Literati, or gives a Literati project URL (…/project/<id>) — pair with this tool rather than fetching or curling the URL to connect (opening it in the user's browser for them is fine). Also call it when the user asks to pair, re-pair, log in again, or switch the project of a folder that is already paired — a new pairing replaces the old one, so never answer that it is already paired. Pairing goes through the Literati desktop app: it opens a project picker there (starting the app if needed); if the app isn't installed the call fails and tells the user where to download it — relay that, there is no other way to pair. Do not ask for a project URL up front — call this with none unless the user already gave one. BEFORE calling, tell the user: \"A Literati window will open — pick the project and click Accept.\" The call waits (up to ~3 minutes) for them to accept in the app. If it fails (app not installed or signed out, the user declined, the request expired, or the app is connected to a different server than this plugin), relay the message as-is — it says what to fix — and never ask for a project URL to get around it.",
  inputSchema: {
    type: 'object',
    properties: {
      project_url: {
        type: 'string',
        description: 'Optional. The Literati project URL (…/project/<id>) or bare project id/slug. Preselects the project in the desktop app.',
      },
    },
    additionalProperties: false,
  },
};

/** Cached remote tool list for the current credential. */
let remoteTools = null;

// Shown when logged out or the server was unreachable at startup. The MCP
// SDK only reads `instructions` once (initialize handshake), so the full
// server-authored guidance can't be swapped in post-login — this fallback
// carries the safety-critical rules; the next session gets the real text.
const FALLBACK_INSTRUCTIONS = [
  'Literati manages LaTeX research projects with server-side files and a paper library.',
  "When the user gives a Literati project URL or asks to connect Literati, pair by calling literati_login (with the URL if given) — don't fetch or curl the URL to connect (opening it in the user's browser for them is fine). If Literati tools are missing or a Literati tool fails with \"Not logged in\", pair the same way (no project URL needed up front — pairing goes through the Literati desktop app).",
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
// a mid-session login it would keep only the login tool until a restart.
// For such clients, advertise the catalog snapshot up front: until the folder
// is paired every call answers "not logged in", and once it is the same names
// just work (handleRemoteTool re-reads the credential on every call). Claude
// Code keeps the login-only list until login — it refreshes on list_changed.
function listsToolsOnce() {
  return clientKind() === 'codex';
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!remoteTools) remoteTools = await fetchRemoteTools();
  const tools = [LOGIN_TOOL];
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
  // Every other outcome ends the attempt: pairing needs the desktop app, and
  // there is no fallback.
  return text(desktopOutcomeMessage(desktop, 'call literati_login again'), true);
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
      'Not logged in to Literati. Call literati_login to pair this directory through the Literati desktop app (no project URL needed up front).',
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
  return handleRemoteTool(name, args);
});

const transport = new StdioServerTransport();
await server.connect(transport);
