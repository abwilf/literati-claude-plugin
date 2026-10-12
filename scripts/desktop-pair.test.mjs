// Desktop pairing: the plugin asks the running Literati desktop app's local
// connector for a code, and refuses to pair when there is no usable app (the
// pairing-code flow is only for an app on another server, or for
// LITERATI_DESKTOP_PAIR=0). Fake connector + fake Literati server over real
// HTTP; the MCP-server tests drive the BUILT mcp/bundle.mjs — rebuild first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopPair, desktopOutcomeMessage } from '../lib/pairing.mjs';
import { tempHome, session, stubServer, callTool, textOf } from './mcp-test-helpers.mjs';

const LOGIN = fileURLToPath(new URL('./login.mjs', import.meta.url));

/** HTTP server whose routes are `"METHOD /path"` → (req, body) => [status, json]
 * (or a promise of one; `null` = never answer, like a stalled long-poll).
 * Records every request with its arrival and answer times. */
function fake(routes) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const entry = { method: req.method, url: req.url, headers: req.headers, body, at: Date.now() };
      seen.push(entry);
      const route = routes[`${req.method} ${req.url}`];
      const answer = route ? await route(req, body) : [404, {}];
      if (!answer) return;
      const [status, json] = answer;
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(json));
      entry.answeredAt = Date.now();
    });
  });
  const close = server.close.bind(server);
  server.close = () => (close(), server.closeAllConnections());
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

function connector({ serverUrl, signedIn = true, polls, pollDelayMs = 0 }) {
  const queue = [...polls];
  return fake({
    'GET /cli-pair/hello': () => [200, { app: 'literati', serverUrl, signedIn }],
    'POST /cli-pair': () => [202, { pairId: 'pair-1' }],
    'GET /cli-pair/pair-1': async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === 'hang') return null;
      await new Promise((r) => setTimeout(r, pollDelayMs));
      return [200, next];
    },
    'DELETE /cli-pair/pair-1': () => [204, {}],
  });
}

const deletes = (conn) => conn.seen.filter((s) => s.method === 'DELETE' && s.url === '/cli-pair/pair-1');

const literati = () =>
  fake({
    'POST /cli/pairing/requests': () => [200, { requestId: 'code-flow-req' }],
    'POST /cli/pairing/requests/req-9/exchange': (_req, body) =>
      body?.code === 'DESKCODE'
        ? [200, { token: 'tok', collectionId: 'coll-1', workspaceId: 'ws', userId: 'u', projectSlug: 'slug', projectName: 'Desk Project' }]
        : [400, { code: 'PAIRING_INVALID_CODE' }],
  });

const deadPort = async () => {
  const s = await fake({});
  s.server.close();
  return s.url;
};

const base = { serverUrl: 'http://srv', cwd: '/tmp/x', requesterLabel: 'me@host' };

test('unreachable app, launch fails → unavailable, whose message refuses and names the download page', async () => {
  let launches = 0;
  const r = await desktopPair({
    ...base,
    connectorUrl: await deadPort(),
    launch: async () => (launches++, false),
  });
  assert.deepEqual(r, { kind: 'unavailable' });
  assert.equal(launches, 1);
  assert.equal(
    desktopOutcomeMessage(r, 'retry'),
    "The Literati desktop app isn't installed, couldn't be started, or is too old for CLI pairing. Pairing needs it: download the latest from https://literati.ai/download, open it and sign in, then retry.",
  );
});

test('LITERATI_DESKTOP_PAIR=0 → disabled, without probing or launching (the code-flow escape hatch)', async () => {
  const prev = process.env.LITERATI_DESKTOP_PAIR;
  process.env.LITERATI_DESKTOP_PAIR = '0';
  try {
    const r = await desktopPair({
      ...base,
      connectorUrl: await deadPort(),
      launch: async () => assert.fail('must not launch the app'),
    });
    assert.deepEqual(r, { kind: 'disabled' });
  } finally {
    if (prev === undefined) delete process.env.LITERATI_DESKTOP_PAIR;
    else process.env.LITERATI_DESKTOP_PAIR = prev;
  }
});

test('unreachable app that comes up after launch is re-probed and used', async () => {
  const conn = await connector({ serverUrl: 'http://srv', polls: [{ status: 'denied' }] });
  const port = new URL(conn.url).port;
  conn.server.close(); // down at first probe
  try {
    const r = await desktopPair({
      ...base,
      connectorUrl: conn.url,
      probeIntervalMs: 50,
      launchWaitMs: 3000,
      launch: async () => {
        setTimeout(() => conn.server.listen(port, '127.0.0.1'), 200);
        return true;
      },
    });
    assert.deepEqual(r, { kind: 'denied' });
  } finally {
    conn.server.close();
  }
});

test('serverUrl mismatch → server_mismatch; a trailing slash is not a mismatch', async () => {
  const conn = await connector({ serverUrl: 'https://api.literati.ai', polls: [{ status: 'denied' }] });
  try {
    const r = await desktopPair({ ...base, connectorUrl: conn.url, launch: async () => false });
    assert.deepEqual(r, { kind: 'server_mismatch', appServerUrl: 'https://api.literati.ai' });
    assert.ok(!conn.seen.some((s) => s.method === 'POST'), 'must not create a pair request');

    const ok = await desktopPair({ ...base, serverUrl: 'https://api.literati.ai/', connectorUrl: conn.url });
    assert.equal(ok.kind, 'denied');
  } finally {
    conn.server.close();
  }
});

test('signed out → signed_out, no pair request', async () => {
  const conn = await connector({ serverUrl: 'http://srv', signedIn: false, polls: [{ status: 'denied' }] });
  try {
    assert.deepEqual(await desktopPair({ ...base, connectorUrl: conn.url }), { kind: 'signed_out' });
    assert.ok(!conn.seen.some((s) => s.method === 'POST'));
  } finally {
    conn.server.close();
  }
});

test('pending polls until approved; requests carry the connector header, no Origin; body has cwd/label/project', async () => {
  const conn = await connector({
    serverUrl: 'http://srv',
    polls: [{ status: 'pending' }, { status: 'pending' }, { status: 'approved', requestId: 'req-9', code: 'DESKCODE', serverUrl: 'http://srv', projectSlug: 's', projectName: 'P' }],
  });
  try {
    const r = await desktopPair({ ...base, project: 'abc', connectorUrl: conn.url });
    assert.equal(r.kind, 'approved');
    assert.equal(r.requestId, 'req-9');
    assert.equal(r.code, 'DESKCODE');
    for (const s of conn.seen) {
      assert.equal(s.headers['x-literati-connector'], '1');
      assert.equal(s.headers.origin, undefined);
    }
    const post = conn.seen.find((s) => s.method === 'POST');
    assert.deepEqual(post.body, { cwd: '/tmp/x', requesterLabel: 'me@host', project: 'abc' });
    assert.equal(conn.seen.filter((s) => s.url === '/cli-pair/pair-1').length, 3);
  } finally {
    conn.server.close();
  }
});

test('client is sent in the POST /cli-pair body and as X-Literati-Client on every connector request', async () => {
  const conn = await connector({ serverUrl: 'http://srv', polls: [{ status: 'denied' }] });
  try {
    assert.deepEqual(await desktopPair({ ...base, client: 'codex', connectorUrl: conn.url }), { kind: 'denied' });
    const post = conn.seen.find((s) => s.method === 'POST');
    assert.deepEqual(post.body, { cwd: '/tmp/x', requesterLabel: 'me@host', client: 'codex' });
    for (const s of conn.seen) assert.equal(s.headers['x-literati-client'], 'codex', `${s.method} ${s.url}`);

    // Unknown client (null): no field, no header.
    conn.seen.length = 0;
    await desktopPair({ ...base, client: null, connectorUrl: conn.url });
    assert.ok(!('client' in conn.seen.find((s) => s.method === 'POST').body));
    for (const s of conn.seen) assert.equal(s.headers['x-literati-client'], undefined);
  } finally {
    conn.server.close();
  }
});

test('busy / expired / unknown pairId', async () => {
  const busy = await fake({
    'GET /cli-pair/hello': () => [200, { app: 'literati', serverUrl: 'http://srv', signedIn: true }],
    'POST /cli-pair': () => [409, { error: 'busy' }],
  });
  const gone = await fake({
    'GET /cli-pair/hello': () => [200, { app: 'literati', serverUrl: 'http://srv', signedIn: true }],
    'POST /cli-pair': () => [202, { pairId: 'nope' }],
  });
  const expired = await connector({ serverUrl: 'http://srv', polls: [{ status: 'expired' }] });
  try {
    assert.deepEqual(await desktopPair({ ...base, connectorUrl: busy.url }), { kind: 'busy' });
    assert.deepEqual(await desktopPair({ ...base, connectorUrl: gone.url }), { kind: 'expired' });
    assert.deepEqual(await desktopPair({ ...base, connectorUrl: expired.url }), { kind: 'expired' });
  } finally {
    busy.server.close();
    gone.server.close();
    expired.server.close();
  }
});

test('the app\'s not_shown expiry gets its own message', async () => {
  const conn = await connector({ serverUrl: 'http://srv', polls: [{ status: 'expired', reason: 'not_shown' }] });
  try {
    const r = await desktopPair({ ...base, connectorUrl: conn.url });
    assert.deepEqual(r, { kind: 'not_shown' });
    assert.equal(
      desktopOutcomeMessage(r, 'retry'),
      "The Literati desktop app is running but didn't show the pairing window — it may still be starting up, or be signed out. Make sure it's open and signed in, then retry.",
    );
  } finally {
    conn.server.close();
  }
});

test('re-polls as soon as each long-poll returns', async () => {
  const conn = await connector({ serverUrl: 'http://srv', polls: [{ status: 'pending' }], pollDelayMs: 1100 });
  try {
    const r = await desktopPair({ ...base, connectorUrl: conn.url, pollDeadlineMs: 3600 });
    assert.equal(r.kind, 'timeout');
    const polls = conn.seen.filter((s) => s.method === 'GET' && s.url === '/cli-pair/pair-1');
    assert.ok(polls.length >= 3, `expected >=3 polls, got ${polls.length}`);
    for (let i = 1; i < polls.length; i++) {
      const gap = polls[i].at - polls[i - 1].answeredAt;
      assert.ok(gap < 200, `poll ${i} came ${gap}ms after the previous one returned`);
    }
  } finally {
    conn.server.close();
  }
});

test('our deadline passing withdraws the request with a DELETE', async () => {
  const conn = await connector({ serverUrl: 'http://srv', polls: [{ status: 'pending' }] });
  try {
    const r = await desktopPair({ ...base, connectorUrl: conn.url, pollDeadlineMs: 300 });
    assert.equal(r.kind, 'timeout');
    const del = deletes(conn);
    assert.equal(del.length, 1);
    assert.equal(del[0].headers['x-literati-connector'], '1');
    assert.equal(del[0].headers.origin, undefined);
  } finally {
    conn.server.close();
  }
});

test('an abort mid long-poll stops polling and withdraws the request', async () => {
  const conn = await connector({ serverUrl: 'http://srv', polls: ['hang'] });
  const ac = new AbortController();
  try {
    const started = Date.now();
    setTimeout(() => ac.abort(), 300);
    const r = await desktopPair({ ...base, connectorUrl: conn.url, signal: ac.signal });
    assert.deepEqual(r, { kind: 'cancelled' });
    assert.ok(Date.now() - started < 3000, 'must not wait out the long-poll');
    assert.equal(deletes(conn).length, 1);
    const pollsAtAbort = conn.seen.filter((s) => s.method === 'GET' && s.url === '/cli-pair/pair-1').length;
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(conn.seen.filter((s) => s.method === 'GET' && s.url === '/cli-pair/pair-1').length, pollsAtAbort, 'no polls after abort');
  } finally {
    conn.server.close();
  }
});

// --- CLI (scripts/login.mjs), isolated HOME -------------------------------

function run(args, { home, cwd, url, connectorUrl, onSpawn, desktopPairEnv = '' }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [LOGIN, ...args], {
      cwd,
      env: { ...process.env, HOME: home, LITERATI_SERVER_URL: url, LITERATI_CONNECTOR_URL: connectorUrl, LITERATI_DESKTOP_PAIR: desktopPairEnv },
    });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (status) => resolve({ status, stdout, stderr }));
    onSpawn?.(c);
  });
}

async function cliEnv() {
  const home = mkdtempSync(join(tmpdir(), 'literati-desk-'));
  const cwd = join(home, 'proj');
  mkdirSync(cwd);
  return { home, cwd };
}

test('CLI: approved in the app → exchange with its requestId+code, credential bound to cwd', async () => {
  const srv = await literati();
  const conn = await connector({
    serverUrl: `${srv.url}/`,
    polls: [{ status: 'approved', requestId: 'req-9', code: 'DESKCODE', serverUrl: srv.url, projectSlug: 'slug', projectName: 'Desk Project' }],
  });
  const { home, cwd } = await cliEnv();
  try {
    const r = await run(['start'], { home, cwd, url: srv.url, connectorUrl: conn.url });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Logged in to Literati project "Desk Project"/);
    const ex = srv.seen.find((s) => s.url.endsWith('/exchange'));
    assert.equal(ex.url, '/cli/pairing/requests/req-9/exchange');
    assert.deepEqual(ex.body, { code: 'DESKCODE' });
    assert.equal(ex.headers['x-literati-client'], 'claude-code');
    assert.ok(!srv.seen.some((s) => s.url === '/cli/pairing/requests'), 'no code-flow request');
    const post = conn.seen.find((s) => s.method === 'POST');
    assert.equal(post.body.cwd, realpathSync(cwd));
    assert.equal(post.body.client, 'claude-code');
    for (const s of conn.seen) assert.equal(s.headers['x-literati-client'], 'claude-code');
    const creds = JSON.parse(readFileSync(join(home, '.literati', 'credentials.json'), 'utf8'));
    assert.deepEqual(Object.keys(creds.directories), [realpathSync(cwd)]);
  } finally {
    srv.server.close();
    conn.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: denied in the app → failure, no fallback, nothing saved', async () => {
  const srv = await literati();
  const conn = await connector({ serverUrl: srv.url, polls: [{ status: 'denied' }] });
  const { home, cwd } = await cliEnv();
  try {
    const r = await run(['start', 'abc'], { home, cwd, url: srv.url, connectorUrl: conn.url });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /declined/);
    assert.equal(srv.seen.length, 0, 'no code flow, no exchange');
    assert.throws(() => readFileSync(join(home, '.literati', 'credentials.json')));
  } finally {
    srv.server.close();
    conn.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: server mismatch → code flow with a note; without a project, asks for one', async () => {
  const srv = await literati();
  const conn = await connector({ serverUrl: 'https://api.literati.ai', polls: [{ status: 'denied' }] });
  const { home, cwd } = await cliEnv();
  try {
    const r = await run(['start', 'abc'], { home, cwd, url: srv.url, connectorUrl: conn.url });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /connected to https:\/\/api\.literati\.ai/);
    assert.match(r.stdout, /Pairing request sent/);
    assert.ok(srv.seen.some((s) => s.url === '/cli/pairing/requests'));

    const noProj = await run(['start'], { home, cwd, url: srv.url, connectorUrl: conn.url });
    assert.equal(noProj.status, 1);
    assert.match(noProj.stderr, /project URL/);
  } finally {
    srv.server.close();
    conn.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: no usable desktop app (something on the connector port, no /cli-pair/hello) → refuses with the download link; no project-URL prompt, no code flow', async () => {
  const srv = await literati();
  const old = await fake({}); // e.g. an older app version: 404 everywhere — reachable, so nothing is launched
  const { home, cwd } = await cliEnv();
  try {
    for (const args of [['start'], ['start', 'abc']]) {
      const r = await run(args, { home, cwd, url: srv.url, connectorUrl: old.url });
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /https:\/\/literati\.ai\/download/);
      assert.doesNotMatch(r.stderr, /project URL/);
      assert.doesNotMatch(r.stdout, /Pairing request sent/);
    }
    assert.equal(srv.seen.length, 0, 'no code flow, no exchange');
    assert.ok(!existsSync(join(home, '.literati', 'pairing-pending.json')));
  } finally {
    srv.server.close();
    old.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: LITERATI_DESKTOP_PAIR=0 → the code flow, which asks for a project', async () => {
  const srv = await literati();
  const { home, cwd } = await cliEnv();
  try {
    const noProj = await run(['start'], { home, cwd, url: srv.url, connectorUrl: await deadPort(), desktopPairEnv: '0' });
    assert.equal(noProj.status, 1);
    assert.match(noProj.stderr, /LITERATI_DESKTOP_PAIR=0/);
    assert.match(noProj.stderr, /project URL/);
    const r = await run(['start', 'abc'], { home, cwd, url: srv.url, connectorUrl: await deadPort(), desktopPairEnv: '0' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Pairing request sent/);
    assert.ok(srv.seen.some((s) => s.url === '/cli/pairing/requests'));
  } finally {
    srv.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: an approved desktop pairing removes a stale pairing-pending.json', async () => {
  const srv = await literati();
  const conn = await connector({ serverUrl: srv.url, polls: [{ status: 'approved', requestId: 'req-9', code: 'DESKCODE' }] });
  const { home, cwd } = await cliEnv();
  const pending = join(home, '.literati', 'pairing-pending.json');
  mkdirSync(join(home, '.literati'));
  writeFileSync(pending, JSON.stringify({ requestId: 'old', serverUrl: srv.url, cwd, createdAt: new Date().toISOString() }));
  try {
    const r = await run(['start'], { home, cwd, url: srv.url, connectorUrl: conn.url });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Logged in to Literati project "Desk Project"/);
    assert.ok(!existsSync(pending), 'the stale code-flow marker must be removed');
  } finally {
    srv.server.close();
    conn.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: Ctrl-C while waiting in the app withdraws the request and exits 130', async () => {
  const srv = await literati();
  const conn = await connector({ serverUrl: srv.url, polls: ['hang'] });
  const { home, cwd } = await cliEnv();
  try {
    const r = await run(['start'], {
      home, cwd, url: srv.url, connectorUrl: conn.url,
      onSpawn: (child) => {
        const t = setInterval(() => {
          if (conn.seen.some((s) => s.method === 'GET' && s.url === '/cli-pair/pair-1')) {
            clearInterval(t);
            child.kill('SIGINT');
          }
        }, 20);
      },
    });
    assert.equal(r.status, 130, r.stderr);
    assert.equal(deletes(conn).length, 1);
    assert.equal(srv.seen.length, 0, 'no exchange, no code flow');
  } finally {
    srv.server.close();
    conn.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// --- MCP server (mcp/bundle.mjs), isolated HOME ----------------------------

const mcpLiterati = (t) =>
  stubServer(t, {
    'POST /cli/pairing/requests': { requestId: 'code-flow-req' },
    'POST /cli/pairing/requests/req-9/exchange': { token: 'tok', collectionId: 'coll-1', workspaceId: 'ws', userId: 'u', projectSlug: 'slug', projectName: 'Desk Project' },
    'GET /mcp-agent/tools': { tools: [], instructions: 'live' },
  });

test('MCP: no usable desktop app → literati_login refuses with the download link; no project-URL prompt, no code flow', { timeout: 30_000 }, async (t) => {
  const srv = await mcpLiterati(t);
  const old = await stubServer(t, {}); // reachable, no /cli-pair/hello → nothing is launched
  const { results } = await session(
    tempHome(t),
    'claude-code',
    [callTool('literati_login'), callTool('literati_login', { project_url: 'abc' })],
    { serverUrl: srv.url, env: { LITERATI_DESKTOP_PAIR: '1', LITERATI_CONNECTOR_URL: old.url } },
  );
  for (const r of results) {
    assert.equal(r.isError, true, textOf(r));
    assert.match(textOf(r), /https:\/\/literati\.ai\/download/);
    assert.doesNotMatch(textOf(r), /project URL/);
  }
  assert.ok(!srv.requests.some((r) => r.url === '/cli/pairing/requests'), 'no code-flow request');
});

test('MCP: LITERATI_DESKTOP_PAIR=0 → the code flow, which asks for a project', { timeout: 30_000 }, async (t) => {
  const srv = await mcpLiterati(t);
  const { results } = await session(
    tempHome(t),
    'claude-code',
    [callTool('literati_login'), callTool('literati_login', { project_url: 'abc' })],
    { serverUrl: srv.url }, // the harness default is LITERATI_DESKTOP_PAIR=0
  );
  assert.equal(results[0].isError, true);
  assert.match(textOf(results[0]), /LITERATI_DESKTOP_PAIR=0/);
  assert.match(textOf(results[0]), /project URL/);
  assert.match(textOf(results[1]), /Pairing request sent/);
  assert.ok(srv.requests.some((r) => r.url === '/cli/pairing/requests'));
});

test('MCP: an approved desktop pairing removes a stale pairing-pending.json', { timeout: 30_000 }, async (t) => {
  const srv = await mcpLiterati(t);
  const conn = await stubServer(t, {
    'GET /cli-pair/hello': { app: 'literati', serverUrl: srv.url, signedIn: true },
    'POST /cli-pair': (_body, res) => {
      res.statusCode = 202;
      return { pairId: 'p1' };
    },
    'GET /cli-pair/p1': { status: 'approved', requestId: 'req-9', code: 'DESKCODE' },
  });
  const home = tempHome(t);
  const pending = join(home, '.literati', 'pairing-pending.json');
  mkdirSync(join(home, '.literati'));
  writeFileSync(pending, JSON.stringify({ requestId: 'old', serverUrl: srv.url, cwd: home, createdAt: new Date().toISOString() }));
  const { results } = await session(home, 'claude-code', [callTool('literati_login')], {
    serverUrl: srv.url,
    env: { LITERATI_DESKTOP_PAIR: '1', LITERATI_CONNECTOR_URL: conn.url },
  });
  assert.match(textOf(results[0]), /Logged in to Literati project "Desk Project"/);
  assert.ok(!existsSync(pending), 'the stale code-flow marker must be removed');
});
