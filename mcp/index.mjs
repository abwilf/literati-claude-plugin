#!/usr/bin/env node
// Literati MCP server (stdio): proxies Literati's agent tools to Claude Code.
//
// Two states:
//   - Not logged in: only `literati_login` / `literati_login_code` are
//     exposed; every other capability tells the model to run the login flow.
//   - Logged in (~/.literati/credentials.json has a default project): the
//     server-side tool list (GET /mcp-agent/tools) is exposed 1:1; calls
//     proxy to POST /mcp-agent/tools/execute with the paired bearer token.
//
// Login is two tools (not one interactive flow) because MCP tools cannot
// prompt the user — the model relays instructions between the tools.
import os from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  addProjectCredential,
  getCredentialForDir,
} from '../lib/credentials.mjs';

// Claude Code launches stdio MCP servers with the session's working
// directory, so cwd-bound credentials resolve the right project per repo
// (falling back to the machine-wide default inside getCredentialForDir).
const activeCredential = () => getCredentialForDir(process.cwd());

const DEFAULT_SERVER_URL = process.env.LITERATI_SERVER_URL || 'http://localhost:3000';
const EXECUTE_TIMEOUT_MS = 9 * 60_000; // compile can be slow

const LOGIN_TOOL = {
  name: 'literati_login',
  description:
    'Start pairing this Claude Code instance with a Literati project. Ask the user for their Literati project URL (or project id/slug) first, then call this tool with it. It sends an approval prompt to the project page in the Literati web app.',
  inputSchema: {
    type: 'object',
    properties: {
      project_url: {
        type: 'string',
        description: 'The Literati project URL (https://…/project/<id>) or bare project id/slug.',
      },
    },
    required: ['project_url'],
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
  'If Literati tools are missing or fail with a login error, pair via the literati_login flow (ask the user for their project URL).',
  'NEVER hand-edit .bib bibliography files — add references with the add_paper tool (hand-written BibTeX risks hallucinated citations); .bib edits require explicit in-app user approval.',
  'After editing .tex/.bib/.sty files, run the compile tool and fix errors before finishing.',
  'Only use stage_changes / commit_changes when the user explicitly asks.',
].join('\n');

function text(s, isError = false) {
  return { content: [{ type: 'text', text: s }], isError };
}

async function api(cred, path, init = {}) {
  const res = await fetch(`${cred.serverUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cred.token}`,
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

async function fetchRemoteTools() {
  const startup = await fetchToolsAndInstructions();
  return startup?.tools ?? null;
}

// Instructions are constructor-only in the MCP SDK (read once during the
// initialize handshake), so fetch them BEFORE constructing the server —
// bounded to 2s so a down server never blocks Claude Code startup.
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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!remoteTools) remoteTools = await fetchRemoteTools();
  const tools = [LOGIN_TOOL, LOGIN_CODE_TOOL];
  for (const t of remoteTools ?? []) {
    tools.push({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    });
  }
  return { tools };
});

async function handleLogin(args) {
  const projectUrl = String(args?.project_url ?? '').trim();
  if (!projectUrl) return text('project_url is required.', true);

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
    return text(`Could not reach the Literati server at ${serverUrl}: ${err.message}`, true);
  }
  if (res.status === 404) {
    return text('Literati could not find that project. Double-check the project URL.', true);
  }
  if (!res.ok) {
    return text(`Pairing request failed: HTTP ${res.status}`, true);
  }
  const body = await res.json();
  pendingPairing = { requestId: body.requestId, serverUrl };
  return text(
    [
      'Pairing request sent.',
      'Tell the user to:',
      '  1. Open the project page in the Literati web app (the URL they gave you).',
      '  2. Approve the "Claude Code pairing request" prompt that appears there.',
      '  3. Copy the one-time code Literati shows and paste it here.',
      'When the user gives you the code, call literati_login_code with it.',
      'The request expires in 10 minutes.',
    ].join('\n'),
  );
}

async function handleLoginCode(args) {
  const code = String(args?.code ?? '').trim();
  if (!code) return text('code is required.', true);
  if (!pendingPairing) {
    return text('No pairing in progress — call literati_login with the project URL first.', true);
  }
  let res;
  try {
    res = await fetch(
      `${pendingPairing.serverUrl}/cli/pairing/requests/${pendingPairing.requestId}/exchange`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (err) {
    return text(`Could not reach the Literati server: ${err.message}`, true);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body?.code === 'PAIRING_INVALID_CODE') {
      return text('That code is not correct — ask the user to re-check it and try again.', true);
    }
    return text(
      'Pairing could not be completed (expired, denied, or too many attempts). Start over with literati_login.',
      true,
    );
  }
  const body = await res.json();
  // Bind the credential to this working directory: reopening Claude Code
  // here (or in a subdirectory) resolves this project automatically.
  addProjectCredential(
    {
      serverUrl: pendingPairing.serverUrl,
      token: body.token,
      collectionId: body.collectionId,
      workspaceId: body.workspaceId,
      userId: body.userId,
      projectSlug: body.projectSlug,
      projectName: body.projectName,
    },
    process.cwd(),
  );
  pendingPairing = null;
  remoteTools = await fetchRemoteTools();
  try {
    await server.sendToolListChanged();
  } catch {
    /* client may not support listChanged */
  }
  const toolCount = remoteTools?.length ?? 0;
  return text(
    `Logged in to Literati project "${body.projectName}". ${
      toolCount > 0
        ? `${toolCount} Literati tools are now available.`
        : 'If Literati tools do not appear, reconnect the MCP server (or restart Claude Code).'
    }`,
  );
}

async function handleRemoteTool(name, args) {
  const cred = activeCredential();
  if (!cred) {
    return text(
      'Not logged in to Literati. Ask the user for their Literati project URL and call literati_login.',
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

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'literati_login') return handleLogin(args);
  if (name === 'literati_login_code') return handleLoginCode(args);
  return handleRemoteTool(name, args);
});

const transport = new StdioServerTransport();
await server.connect(transport);
