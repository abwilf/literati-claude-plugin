// Drives the BUILT server (mcp/bundle.mjs) over stdio the way the clients do,
// with HOME pointed at a temp dir, and checks which tools each client sees:
//   - Codex lists tools once and ignores tools/list_changed → when the remote
//     list is unavailable (unpaired, or server down) it must get the full
//     catalog up front, or a mid-session login leaves it with only the login
//     tools until a restart.
//   - Claude Code refreshes on list_changed → it keeps the two login tools.
//   - Paired with the server up, both get the live list.
// Rebuild first after editing mcp/index.mjs: `(cd mcp && npm run build)`.
// Run: `node --test scripts/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE = join(ROOT, 'mcp', 'bundle.mjs');
const CATALOG = JSON.parse(readFileSync(join(ROOT, 'mcp', 'tool-catalog.json'), 'utf8'));
const LOGIN_TOOLS = ['literati_login', 'literati_login_code'];
const CATALOG_NAMES = CATALOG.tools.map((t) => t.name);
const REPLY_TIMEOUT_MS = 10_000;
const DEAD_SERVER = 'http://127.0.0.1:9';

/** A throwaway HOME (removed after the test); optionally paired to `serverUrl`. */
function tempHome(t, serverUrl) {
  // Real path: the server resolves pairing from process.cwd(), which is
  // symlink-resolved (macOS tmp is /var → /private/var).
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'literati-mcp-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (serverUrl) {
    mkdirSync(join(home, '.literati'));
    const key = `${serverUrl}|c1`;
    writeFileSync(
      join(home, '.literati', 'credentials.json'),
      JSON.stringify({
        version: 1,
        projects: { [key]: { serverUrl, token: 't', collectionId: 'c1', projectName: 'Proj' } },
        directories: { [home]: key },
      }),
    );
  }
  return home;
}

/** Start the server as `clientName` in `home`, run `requests` in order, return their results. */
async function session(home, clientName, requests) {
  const child = spawn(process.execPath, [BUNDLE], {
    cwd: home,
    // Unpaired calls resolve against this; nothing here may reach a real server.
    env: { ...process.env, HOME: home, LITERATI_SERVER_URL: DEAD_SERVER },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit').then(([code]) => {
    throw new Error(`MCP server exited (code ${code}) before replying`);
  });
  exited.catch(() => {});
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const send = (method, params) => {
    const id = nextId++;
    const reply = new Promise((res) => waiting.set(id, res));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`no reply to ${method} within ${REPLY_TIMEOUT_MS}ms`)), REPLY_TIMEOUT_MS);
    });
    return Promise.race([reply, exited, timeout]).finally(() => clearTimeout(timer));
  };
  try {
    await send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: clientName, version: '1.0.0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const results = [];
    for (const [method, params] of requests) results.push((await send(method, params)).result);
    return results;
  } finally {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
}

/** A stand-in Literati server whose /mcp-agent/tools returns `tools`. */
async function liveServer(t, tools) {
  const srv = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/mcp-agent/tools') return res.end(JSON.stringify({ tools, instructions: 'live' }));
    res.statusCode = 404;
    res.end('{}');
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}`;
}

const toolNames = (r) => r.tools.map((t) => t.name);
const callTool = (name) => ['tools/call', { name, arguments: {} }];

test('the catalog snapshot is well-formed', () => {
  assert.ok(CATALOG_NAMES.length > 0);
  assert.equal(new Set(CATALOG_NAMES).size, CATALOG_NAMES.length, 'duplicate tool names');
  for (const t of CATALOG.tools) {
    assert.deepEqual(Object.keys(t).sort(), ['description', 'inputSchema', 'name'], t.name);
    assert.equal(typeof t.description, 'string', t.name);
    assert.equal(t.inputSchema?.type, 'object', t.name);
    assert.ok(!LOGIN_TOOLS.includes(t.name), t.name);
  }
});

test('unpaired: Codex sees the login tools plus the full catalog', { timeout: 30_000 }, async (t) => {
  const [list] = await session(tempHome(t), 'codex-mcp-client', [['tools/list', {}]]);
  assert.deepEqual(toolNames(list), [...LOGIN_TOOLS, ...CATALOG_NAMES]);
});

test('unpaired: Claude Code sees only the login tools', { timeout: 30_000 }, async (t) => {
  const [list] = await session(tempHome(t), 'claude-code', [['tools/list', {}]]);
  assert.deepEqual(toolNames(list), LOGIN_TOOLS);
});

test('unpaired: a catalog tool says how to log in', { timeout: 30_000 }, async (t) => {
  const [res] = await session(tempHome(t), 'codex-mcp-client', [callTool(CATALOG_NAMES[0])]);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Not logged in to Literati.*literati_login/);
});

test('paired, server down: Codex keeps the catalog, Claude Code the login tools', { timeout: 30_000 }, async (t) => {
  const [codexList, codexCall] = await session(tempHome(t, DEAD_SERVER), 'codex-mcp-client', [
    ['tools/list', {}],
    callTool(CATALOG_NAMES[0]),
  ]);
  assert.deepEqual(toolNames(codexList), [...LOGIN_TOOLS, ...CATALOG_NAMES]);
  assert.equal(codexCall.isError, true);
  assert.match(codexCall.content[0].text, /Literati request failed/);

  const [claudeList] = await session(tempHome(t, DEAD_SERVER), 'claude-code', [['tools/list', {}]]);
  assert.deepEqual(toolNames(claudeList), LOGIN_TOOLS);
});

test('paired, server stalls: tools/list still answers (bounded fetch)', { timeout: 30_000 }, async (t) => {
  // Accepts the connection, never responds.
  const srv = createServer(() => {});
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => srv.closeAllConnections() || srv.close());
  const url = `http://127.0.0.1:${srv.address().port}`;
  const [list] = await session(tempHome(t, url), 'codex-mcp-client', [['tools/list', {}]]);
  assert.deepEqual(toolNames(list), [...LOGIN_TOOLS, ...CATALOG_NAMES]);
});

test('paired, server up: both clients get the live list, not the catalog', { timeout: 30_000 }, async (t) => {
  const live = [{ name: 'only_live', description: 'live tool', inputSchema: { type: 'object', properties: {} } }];
  const url = await liveServer(t, live);
  for (const client of ['codex-mcp-client', 'claude-code']) {
    const [list] = await session(tempHome(t, url), client, [['tools/list', {}]]);
    assert.deepEqual(toolNames(list), [...LOGIN_TOOLS, 'only_live'], client);
  }
});
