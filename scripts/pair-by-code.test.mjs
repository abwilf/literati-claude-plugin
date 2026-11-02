// Pairing with a pasted code: the fallback for a machine without the Literati
// desktop app. The user mints an 8-character code on the web app's /pair page
// (signed in there) and pastes it into the plugin, which exchanges it with
// POST /cli/pairing/exchange {code} — no request id, nothing opens. Nothing
// here may ever POST /cli/pairing/requests either: the page did that.
// Fake Literati server over real HTTP; the MCP-server tests drive the BUILT
// mcp/bundle.mjs — rebuild first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPairPageUrl, desktopOutcomeMessage, isPairingCode } from '../lib/pairing.mjs';
import { tempHome, session, stubServer, callTool, textOf } from './mcp-test-helpers.mjs';

const LOGIN = fileURLToPath(new URL('./login.mjs', import.meta.url));
const WEB = 'https://app.example.test';
const TOKEN_BODY = { token: 'tok', collectionId: 'coll-1', workspaceId: 'ws', userId: 'u', projectSlug: 'slug', projectName: 'Web Project' };

/** A Literati server that knows one live code and its public config. */
const literati = (t, extra = {}) =>
  stubServer(t, {
    'GET /config/public': { whitelistGateEnabled: false, webAppUrl: `${WEB}/` },
    'POST /cli/pairing/exchange': (body, res) => {
      if (body?.code === 'K7QM2XPT') return TOKEN_BODY;
      res.statusCode = 400;
      return { error: 'Invalid or expired code', code: 'PAIRING_INVALID_CODE' };
    },
    ...extra,
  });

const exchanges = (srv) => srv.requests.filter((r) => r.url === '/cli/pairing/exchange');

// --- lib/pairing.mjs --------------------------------------------------------

test('isPairingCode accepts 8 characters of the unambiguous alphabet, any case, trimmed', () => {
  assert.equal(isPairingCode('K7QM2XPT'), true);
  assert.equal(isPairingCode(' k7qm2xpt '), true);
  assert.equal(isPairingCode('K7QM2XP'), false, 'too short');
  assert.equal(isPairingCode('K7QM2XPT9'), false, 'too long');
  assert.equal(isPairingCode('K0QM2XPT'), false, '0 is not in the alphabet');
  assert.equal(isPairingCode('a'.repeat(24)), false, 'a project slug is not a code');
  assert.equal(isPairingCode('https://app.literati.ai/project/abc'), false);
  assert.equal(isPairingCode(''), false);
});

test('fetchPairPageUrl is the web app URL from the server, with /pair; null when it cannot be had', async (t) => {
  const srv = await literati(t);
  assert.equal(await fetchPairPageUrl(srv.url), `${WEB}/pair`);
  const bare = await stubServer(t, {});
  assert.equal(await fetchPairPageUrl(bare.url), null, '404');
  const older = await stubServer(t, { 'GET /config/public': { whitelistGateEnabled: false } });
  assert.equal(await fetchPairPageUrl(older.url), null, 'no webAppUrl in the body');
  assert.equal(await fetchPairPageUrl('http://127.0.0.1:9'), null, 'nothing listening');
});

test('the no-desktop-app message offers the pairing page and the paste step, and still the download', () => {
  const msg = desktopOutcomeMessage({ kind: 'unavailable' }, 'run `login.mjs start` again', {
    pairUrl: `${WEB}/pair`,
    paste: 'run `login.mjs complete <code>`',
  });
  assert.match(msg, new RegExp(`${WEB}/pair`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.match(msg, /login\.mjs complete <code>/);
  assert.match(msg, /https:\/\/literati\.ai\/download/);
  // Without a known page URL it still describes the path in words.
  const noUrl = desktopOutcomeMessage({ kind: 'unavailable' }, 'run `login.mjs start` again', { pairUrl: null, paste: 'paste it' });
  assert.match(noUrl, /pairing page/i);
  assert.match(noUrl, /paste it/);
});

// --- CLI (scripts/login.mjs), isolated HOME -------------------------------

function run(args, { home, cwd, url, connectorUrl }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [LOGIN, ...args], {
      cwd,
      env: { ...process.env, HOME: home, LITERATI_SERVER_URL: url, LITERATI_CONNECTOR_URL: connectorUrl },
    });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function cliEnv(t) {
  const home = mkdtempSync(join(tmpdir(), 'literati-code-'));
  const cwd = join(home, 'proj');
  mkdirSync(cwd);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, cwd };
}

/** A connector port nobody listens on: the desktop app is not here. */
const deadConnector = async (t) => {
  const s = await stubServer(t, {});
  s.srv.closeAllConnections();
  s.srv.close();
  return s.url;
};

test('CLI: complete <code> exchanges by code, saves the credential bound to cwd, never touches the connector', async (t) => {
  const srv = await literati(t);
  const conn = await stubServer(t, {});
  const { home, cwd } = cliEnv(t);

  const r = await run(['complete', 'k7qm2xpt'], { home, cwd, url: srv.url, connectorUrl: conn.url });

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Logged in to Literati project "Web Project"/);
  assert.equal(exchanges(srv).length, 1);
  assert.deepEqual(exchanges(srv)[0].body, { code: 'K7QM2XPT' });
  assert.equal(exchanges(srv)[0].headers['x-literati-client'], 'claude-code');
  assert.equal(conn.requests.length, 0, 'no connector probe');
  const creds = JSON.parse(readFileSync(join(home, '.literati', 'credentials.json'), 'utf8'));
  assert.deepEqual(Object.keys(creds.directories), [realpathSync(cwd)]);
});

test('CLI: start <code> is the same as complete <code>', async (t) => {
  const srv = await literati(t);
  const conn = await stubServer(t, {});
  const { home, cwd } = cliEnv(t);

  const r = await run(['start', 'K7QM2XPT'], { home, cwd, url: srv.url, connectorUrl: conn.url });

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Logged in to Literati project "Web Project"/);
  assert.equal(conn.requests.length, 0, 'no connector probe');
});

test('CLI: a malformed code is refused before any request', async (t) => {
  const srv = await literati(t);
  const { home, cwd } = cliEnv(t);

  const r = await run(['complete', 'abc'], { home, cwd, url: srv.url, connectorUrl: await deadConnector(t) });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /doesn't look like a Literati pairing code/);
  assert.equal(srv.requests.length, 0);
  const missing = await run(['complete'], { home, cwd, url: srv.url, connectorUrl: await deadConnector(t) });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Usage: login\.mjs <start \[project-url\] \| complete <code> \| status>/);
});

// The lib runs in a child here on purpose: lib/credentials.mjs resolves
// ~/.literati at import time, so an in-process exchange would write to the
// developer's real credential store, and "nothing saved" would prove nothing.
test('CLI: every server refusal gets the matching advice, and nothing is saved', async (t) => {
  const srv = await literati(t, {
    'POST /cli/pairing/exchange': (body, res) => {
      switch (body?.code) {
        case 'AMBGUAMB': res.statusCode = 409; return { code: 'PAIRING_CODE_AMBIGUOUS' };
        case 'USEDUSED': res.statusCode = 409; return { code: 'PAIRING_NOT_EXCHANGEABLE' };
        case 'LMTDLMTD': res.statusCode = 429; return { error: 'Too many requests', code: 'RATE_LIMITED', retryAfterSeconds: 42 };
        case 'TKNCPTKN': res.statusCode = 400; return { error: 'Too many CLI tokens — revoke one first', code: 'CLI_TOKEN_LIMIT' };
        default: res.statusCode = 400; return { error: 'Invalid or expired code', code: 'PAIRING_INVALID_CODE' };
      }
    },
  });
  const page = new RegExp(`${WEB}/pair`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  const cases = [
    ['WRNGCDE2', /not correct, or it expired or was already used/, page],
    ['AMBGUAMB', /not unique/, page],
    ['USEDUSED', /already used or cancelled/, page],
    ['TKNCPTKN', /CLI & agent tokens/, page],
    ['LMTDLMTD', /Try again in 42 seconds/, /again with the same code/],
  ];
  for (const [code, message, advice] of cases) {
    const { home, cwd } = cliEnv(t);
    const r = await run(['complete', code], { home, cwd, url: srv.url, connectorUrl: await deadConnector(t) });
    assert.equal(r.status, 1, code);
    assert.match(r.stderr, message, code);
    assert.match(r.stderr, advice, code);
    assert.ok(!existsSync(join(home, '.literati', 'credentials.json')), `${code}: nothing saved`);
  }
  // A rate limit never sends the user back to the page: the code is still good.
  const limited = srv.requests.filter((s) => s.body?.code === 'LMTDLMTD');
  assert.equal(limited.length, 1);
});

test('CLI: an unreachable server says to retry the same code, not to mint another', async (t) => {
  const { home, cwd } = cliEnv(t);
  const r = await run(['complete', 'K7QM2XPT'], { home, cwd, url: 'http://127.0.0.1:9', connectorUrl: await deadConnector(t) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Could not reach the Literati server/);
  assert.match(r.stderr, /again with the same code/);
  assert.doesNotMatch(r.stderr, /Create a new code/);
  assert.ok(!existsSync(join(home, '.literati', 'credentials.json')));
});

test('CLI: a wrong or expired code fails with the retry path and saves nothing', async (t) => {
  const srv = await literati(t);
  const { home, cwd } = cliEnv(t);

  const r = await run(['complete', 'WRNGCDE2'], { home, cwd, url: srv.url, connectorUrl: await deadConnector(t) });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /not correct, or it expired or was already used/);
  assert.match(r.stderr, new RegExp(`${WEB}/pair`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.match(r.stderr, /login\.mjs complete <code>/);
  assert.ok(!existsSync(join(home, '.literati', 'credentials.json')));
});

test('CLI: start with no desktop app names the pairing page and the paste step instead of only refusing', async (t) => {
  const srv = await literati(t);
  const { home, cwd } = cliEnv(t);

  const r = await run(['start'], { home, cwd, url: srv.url, connectorUrl: await deadConnector(t) });

  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`${WEB}/pair`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.match(r.stderr, /login\.mjs complete <code>/);
  assert.match(r.stderr, /https:\/\/literati\.ai\/download/);
  assert.ok(!srv.requests.some((s) => s.url.startsWith('/cli/pairing')), 'no pairing request without a code');
});

// --- MCP server (mcp/bundle.mjs), isolated HOME ----------------------------

const mcpLiterati = (t, extra = {}) =>
  stubServer(t, {
    'GET /config/public': { whitelistGateEnabled: false, webAppUrl: WEB },
    'POST /cli/pairing/exchange': (body, res) => {
      if (body?.code === 'K7QM2XPT') return TOKEN_BODY;
      res.statusCode = 400;
      return { code: 'PAIRING_INVALID_CODE' };
    },
    'GET /mcp-agent/tools': { tools: [], instructions: 'live' },
    ...extra,
  });

test('MCP: literati_login with a code exchanges it, never probes the desktop app, and sends the client header', { timeout: 30_000 }, async (t) => {
  const srv = await mcpLiterati(t);
  const conn = await stubServer(t, {});
  const home = tempHome(t);
  const { results } = await session(
    home,
    'codex-mcp-client',
    [callTool('literati_login', { code: ' k7qm2xpt ' }), callTool('literati_login', { project_url: 'K7QM2XPT' })],
    { serverUrl: srv.url, env: { LITERATI_CONNECTOR_URL: conn.url } },
  );

  for (const r of results) {
    assert.equal(r.isError, false, textOf(r));
    assert.match(textOf(r), /Logged in to Literati project "Web Project"/);
  }
  assert.equal(conn.requests.length, 0, 'no connector probe, not even for a code handed over as project_url');
  assert.equal(exchanges(srv).length, 2);
  for (const ex of exchanges(srv)) {
    assert.deepEqual(ex.body, { code: 'K7QM2XPT' });
    assert.equal(ex.headers['x-literati-client'], 'codex');
  }
  assert.ok(existsSync(join(home, '.literati', 'credentials.json')));
});

test('MCP: literati_login with a wrong code errors with the retry path; a malformed one never reaches the server', { timeout: 30_000 }, async (t) => {
  const srv = await mcpLiterati(t);
  const conn = await stubServer(t, {});
  const home = tempHome(t);
  const { results } = await session(
    home,
    'claude-code',
    [callTool('literati_login', { code: 'WRNGCDE2' }), callTool('literati_login', { code: 'nope' })],
    { serverUrl: srv.url, env: { LITERATI_CONNECTOR_URL: conn.url } },
  );

  assert.equal(results[0].isError, true);
  assert.match(textOf(results[0]), /not correct, or it expired or was already used/);
  assert.match(textOf(results[0]), /\/pair/);
  assert.match(textOf(results[0]), /literati_login/);
  assert.equal(results[1].isError, true);
  assert.match(textOf(results[1]), /doesn't look like a Literati pairing code/);
  assert.equal(exchanges(srv).length, 1, 'the malformed code was not sent');
  assert.equal(conn.requests.length, 0);
  assert.ok(!existsSync(join(home, '.literati', 'credentials.json')));
});

test('MCP: no desktop app → literati_login names the pairing page and says to call again with the code', { timeout: 30_000 }, async (t) => {
  const srv = await mcpLiterati(t);
  const old = await stubServer(t, {}); // reachable, no /cli-pair/hello → nothing is launched
  const { results } = await session(tempHome(t), 'claude-code', [callTool('literati_login')], {
    serverUrl: srv.url,
    env: { LITERATI_CONNECTOR_URL: old.url },
  });

  assert.equal(results[0].isError, true);
  assert.match(textOf(results[0]), new RegExp(`${WEB}/pair`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.match(textOf(results[0]), /literati_login.*code/);
  assert.match(textOf(results[0]), /https:\/\/literati\.ai\/download/);
  assert.ok(!srv.requests.some((r) => r.url.startsWith('/cli/pairing')), 'no pairing request without a code');
});

test('MCP: the login tool takes an optional code and its description says when to use it', { timeout: 30_000 }, async (t) => {
  const { results } = await session(tempHome(t), 'claude-code', [['tools/list', {}]]);
  const login = results[0].tools.find((tool) => tool.name === 'literati_login');
  assert.ok(login);
  assert.deepEqual(Object.keys(login.inputSchema.properties).sort(), ['code', 'project_url']);
  assert.match(login.description, /code/);
});
