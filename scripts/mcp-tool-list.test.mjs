// Which tools each client sees (drives the BUILT server, mcp/bundle.mjs):
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
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, DEAD_SERVER, tempHome, session, stubServer, toolNames, callTool } from './mcp-test-helpers.mjs';

const CATALOG = JSON.parse(readFileSync(join(ROOT, 'mcp', 'tool-catalog.json'), 'utf8'));
const LOGIN_TOOLS = ['literati_login', 'literati_login_code'];
const CATALOG_NAMES = CATALOG.tools.map((t) => t.name);

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
  const { results: [list] } = await session(tempHome(t), 'codex-mcp-client', [['tools/list', {}]]);
  assert.deepEqual(toolNames(list), [...LOGIN_TOOLS, ...CATALOG_NAMES]);
});

test('unpaired: Claude Code sees only the login tools', { timeout: 30_000 }, async (t) => {
  const { results: [list] } = await session(tempHome(t), 'claude-code', [['tools/list', {}]]);
  assert.deepEqual(toolNames(list), LOGIN_TOOLS);
});

test('unpaired: a catalog tool says how to log in', { timeout: 30_000 }, async (t) => {
  const { results: [res] } = await session(tempHome(t), 'codex-mcp-client', [callTool(CATALOG_NAMES[0])]);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Not logged in to Literati.*literati_login/);
});

test('paired, server down: Codex keeps the catalog, Claude Code the login tools', { timeout: 30_000 }, async (t) => {
  const { results: [codexList, codexCall] } = await session(tempHome(t, DEAD_SERVER), 'codex-mcp-client', [
    ['tools/list', {}],
    callTool(CATALOG_NAMES[0]),
  ]);
  assert.deepEqual(toolNames(codexList), [...LOGIN_TOOLS, ...CATALOG_NAMES]);
  assert.equal(codexCall.isError, true);
  assert.match(codexCall.content[0].text, /Literati request failed/);

  const { results: [claudeList] } = await session(tempHome(t, DEAD_SERVER), 'claude-code', [['tools/list', {}]]);
  assert.deepEqual(toolNames(claudeList), LOGIN_TOOLS);
});

test('paired, server stalls: tools/list still answers (bounded fetch)', { timeout: 30_000 }, async (t) => {
  // Accepts the connection, never responds.
  const srv = createServer(() => {});
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => {
    srv.closeAllConnections();
    srv.close();
  });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const { results: [list] } = await session(tempHome(t, url), 'codex-mcp-client', [['tools/list', {}]]);
  assert.deepEqual(toolNames(list), [...LOGIN_TOOLS, ...CATALOG_NAMES]);
});

test('paired, server up: both clients get the live list, not the catalog', { timeout: 30_000 }, async (t) => {
  const live = [{ name: 'only_live', description: 'live tool', inputSchema: { type: 'object', properties: {} } }];
  const { url } = await stubServer(t, { 'GET /mcp-agent/tools': { tools: live, instructions: 'live' } });
  for (const client of ['codex-mcp-client', 'claude-code']) {
    const { results: [list] } = await session(tempHome(t, url), client, [['tools/list', {}]]);
    assert.deepEqual(toolNames(list), [...LOGIN_TOOLS, 'only_live'], client);
  }
});
