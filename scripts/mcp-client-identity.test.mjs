// Client-neutral wording + client identity (drives the BUILT server):
//   - every request to Literati carries X-Literati-Client (codex | claude-code)
//     so the server can label the pairing prompt and telemetry; unknown
//     clients send nothing,
//   - nothing the model or user sees says "Claude Code",
//   - the model is told a Literati project URL means literati_login (Codex
//     otherwise fetched the URL with curl), and — for clients that list tools
//     once — that the tools are ready right after login.
// Rebuild first after editing mcp/index.mjs: `(cd mcp && npm run build)`.
// Run: `node --test scripts/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ROOT, tempHome, session, stubServer, callTool, textOf } from './mcp-test-helpers.mjs';

const execFileAsync = promisify(execFile);
const LIVE = [{ name: 'list_papers', description: 'List papers', inputSchema: { type: 'object', properties: {} } }];

/** A stand-in server that completes the pairing (the exchange) and serves tools. */
function pairingServer(t) {
  return stubServer(t, {
    'POST /cli/pairing/requests/r1/exchange': {
      token: 't2',
      collectionId: 'c2',
      workspaceId: 'w',
      userId: 'u',
      projectSlug: 'slug',
      projectName: 'Proj2',
    },
    'GET /mcp-agent/tools': { tools: LIVE, instructions: 'live' },
    'POST /mcp-agent/tools/execute': { success: true, result: 'ok' },
  });
}

/** A stand-in desktop-app connector that approves the first request at once. */
function connectorStub(t, serverUrl) {
  return stubServer(t, {
    'GET /cli-pair/hello': { app: 'literati', serverUrl, signedIn: true },
    'POST /cli-pair': (_body, res) => {
      res.statusCode = 202;
      return { pairId: 'p1' };
    },
    'GET /cli-pair/p1': { status: 'approved', requestId: 'r1', code: 'CODE1234' },
  });
}

/** Unpaired → login through the desktop app → one tool call, as `clientName`. */
async function pairAndCall(t, clientName) {
  const server = await pairingServer(t);
  const conn = await connectorStub(t, server.url);
  const out = await session(
    tempHome(t),
    clientName,
    [['tools/list', {}], callTool('literati_login'), callTool('list_papers')],
    { serverUrl: server.url, env: { LITERATI_CONNECTOR_URL: conn.url } },
  );
  return { ...out, requests: server.requests };
}

const header = (req) => req.headers['x-literati-client'];

for (const [clientName, expected] of [
  ['codex-mcp-client', 'codex'],
  ['claude-code', 'claude-code'],
  ['cursor-vscode', undefined],
]) {
  test(`${clientName}: every Literati request says X-Literati-Client=${expected}`, { timeout: 30_000 }, async (t) => {
    const { results, requests } = await pairAndCall(t, clientName);
    assert.equal(results[2].isError, false, textOf(results[2]));
    const seen = new Set(requests.map((r) => `${r.method} ${r.url}`));
    for (const route of ['POST /cli/pairing/requests/r1/exchange', 'GET /mcp-agent/tools', 'POST /mcp-agent/tools/execute']) {
      assert.ok(seen.has(route), `${route} was not called`);
    }
    for (const req of requests) assert.equal(header(req), expected, `${req.method} ${req.url}`);
  });
}

test('nothing the model sees names Claude Code', { timeout: 30_000 }, async (t) => {
  for (const clientName of ['codex-mcp-client', 'claude-code']) {
    const { init, results } = await pairAndCall(t, clientName);
    const shown = [
      init.instructions,
      ...results[0].tools.map((tool) => tool.description),
      textOf(results[1]),
    ].join('\n');
    assert.doesNotMatch(shown, /Claude Code/, clientName);
  }
});

test('a project URL means literati_login, not fetching it — opening it for the user stays allowed', { timeout: 30_000 }, async (t) => {
  const { init, results } = await session(tempHome(t), 'codex-mcp-client', [['tools/list', {}]]);
  const login = results[0].tools.find((tool) => tool.name === 'literati_login');
  for (const text of [login.description, init.instructions]) {
    assert.match(text, /project URL/);
    assert.match(text, /fetch(ing)? or curl/i);
    // Opening the project URL in the user's browser is harmless; only fetching
    // it to "connect" is wrong, so the wording must not forbid opening.
    assert.match(text, /opening it in the user's browser for them is fine/);
    assert.doesNotMatch(text, /do not open/i);
  }
  // Unpaired Claude Code has only the login tool, so a missing tool must
  // still lead to pairing.
  assert.match(init.instructions, /If Literati tools are missing/);
});

test('paired folder: tool calls and approval waits are labelled; the pre-handshake fetch is not', { timeout: 30_000 }, async (t) => {
  for (const [clientName, expected] of [['codex-mcp-client', 'codex'], ['claude-code', 'claude-code']]) {
    const server = await stubServer(t, {
      'GET /mcp-agent/tools': { tools: LIVE, instructions: 'live' },
      'POST /mcp-agent/tools/execute': (_body, res) => {
        res.statusCode = 202;
        return { approvalId: 'a1' };
      },
      'POST /mcp-agent/approvals/a1/wait': { status: 'approved', success: true, result: 'approved-ok' },
    });
    const { results } = await session(tempHome(t, server.url), clientName, [callTool('list_papers')]);
    assert.equal(textOf(results[0]), 'approved-ok', clientName);
    assert.deepEqual(
      server.requests.map((r) => [`${r.method} ${r.url}`, header(r)]),
      [
        // Runs before `initialize`, when the client is not yet known.
        ['GET /mcp-agent/tools', undefined],
        ['POST /mcp-agent/tools/execute', expected],
        ['POST /mcp-agent/approvals/a1/wait', expected],
      ],
      clientName,
    );
  }
});

test('after login, Codex is told the tools are ready to call', { timeout: 30_000 }, async (t) => {
  const { results } = await pairAndCall(t, 'codex-mcp-client');
  assert.match(textOf(results[1]), /Logged in to Literati project "Proj2"/);
  assert.match(textOf(results[1]), /ready.*call them directly/i);
  assert.doesNotMatch(textOf(results[1]), /restart|reconnect/i);
});

test('login.mjs (Claude Code /literati:login) says claude-code and stays client-neutral', { timeout: 30_000 }, async (t) => {
  const server = await pairingServer(t);
  const conn = await connectorStub(t, server.url);
  const home = tempHome(t);
  // Async: the stub server runs in this process, so a sync spawn would block it.
  const started = await execFileAsync(process.execPath, [join(ROOT, 'scripts', 'login.mjs'), 'start'], {
    cwd: home,
    env: { ...process.env, HOME: home, LITERATI_SERVER_URL: server.url, LITERATI_CONNECTOR_URL: conn.url },
    timeout: 15_000,
  });
  assert.doesNotMatch(started.stdout, /Claude Code/);
  assert.match(started.stdout, /Logged in to Literati project "Proj2"/);
  assert.deepEqual(
    server.requests.map((r) => [r.url, header(r)]),
    [['/cli/pairing/requests/r1/exchange', 'claude-code']],
  );
});

test('after login, Claude Code still gets the tool count', { timeout: 30_000 }, async (t) => {
  const { results } = await pairAndCall(t, 'claude-code');
  assert.match(textOf(results[1]), /Logged in to Literati project "Proj2"\. 1 Literati tools are now available\./);
});

// Desktop pairing: the app's connector learns which client is asking (for its
// picker's wording) from the POST /cli-pair body, and every connector and
// Literati request carries the same X-Literati-Client header.
for (const [clientName, expected] of [
  ['codex-mcp-client', 'codex'],
  ['claude-code', 'claude-code'],
  ['cursor-vscode', undefined],
]) {
  test(`${clientName}: desktop pairing sends client=${expected} to the connector`, { timeout: 30_000 }, async (t) => {
    const server = await pairingServer(t);
    const conn = await connectorStub(t, server.url);
    const { results } = await session(tempHome(t), clientName, [callTool('literati_login')], {
      serverUrl: server.url,
      env: { LITERATI_CONNECTOR_URL: conn.url },
    });
    assert.match(textOf(results[0]), /Logged in to Literati project "Proj2"/);
    const post = conn.requests.find((r) => r.method === 'POST' && r.url === '/cli-pair');
    assert.equal(post.body.client, expected);
    if (expected === undefined) assert.ok(!('client' in post.body), 'unknown client: field omitted');
    for (const req of conn.requests) assert.equal(header(req), expected, `connector ${req.method} ${req.url}`);
    const ex = server.requests.find((r) => r.url === '/cli/pairing/requests/r1/exchange');
    assert.equal(header(ex), expected, 'exchange');
    assert.ok(!server.requests.some((r) => r.url === '/cli/pairing/requests'), 'no code-flow request');
  });
}
