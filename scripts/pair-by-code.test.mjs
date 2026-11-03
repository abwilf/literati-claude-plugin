// Pairing with a pasted code: the fallback for a machine without the Literati
// desktop app. The user mints an 8-character code on the web app's /pair page
// (signed in there) and pastes it into the plugin, which exchanges it with
// POST /cli/pairing/exchange {code} — no request id, nothing opens. Nothing
// here may ever POST /cli/pairing/requests either: the page did that.
// Fake Literati server over real HTTP; the MCP-server tests drive the BUILT
// mcp/bundle.mjs — rebuild first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPairPageUrl, desktopOutcomeMessage, isPairingCode } from '../lib/pairing.mjs';
import { tempHome, session, stubServer, callTool, textOf, deadServer } from './mcp-test-helpers.mjs';

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
/** A regex matching `s` literally. */
const lit = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));

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

test('the no-desktop-app message leads with the pairing page and the paste step; the download comes second', () => {
  const msg = desktopOutcomeMessage({ kind: 'unavailable' }, 'run `login.mjs start` again', {
    pairUrl: `${WEB}/pair`,
    paste: 'run `login.mjs complete <code>`',
  });
  assert.match(msg, new RegExp(`${WEB}/pair`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.match(msg, /login\.mjs complete <code>/);
  assert.match(msg, /https:\/\/literati\.ai\/download/);
  assert.ok(msg.indexOf(`${WEB}/pair`) < msg.indexOf('https://literati.ai/download'), 'the page is named before the download');
  // What the page gives, so the model does not ask for "the code" before the user has one.
  assert.match(msg, /pick the project, type a machine name and copy the 8-character code it shows, then run `login\.mjs complete <code>`\./);
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

test('CLI: a trailing slash in LITERATI_SERVER_URL is dropped: the exchange path is /cli/pairing/exchange and the saved serverUrl has none', async (t) => {
  const srv = await literati(t);
  const conn = await stubServer(t, {});
  const { home, cwd } = cliEnv(t);

  const r = await run(['complete', 'K7QM2XPT'], { home, cwd, url: `${srv.url}/`, connectorUrl: conn.url });

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Logged in to Literati project "Web Project"/);
  assert.deepEqual(srv.requests.filter((s) => s.method === 'POST').map((s) => s.url), ['/cli/pairing/exchange']);
  const creds = JSON.parse(readFileSync(join(home, '.literati', 'credentials.json'), 'utf8'));
  assert.deepEqual(Object.keys(creds.projects), [`${srv.url}|coll-1`]);
  assert.equal(creds.projects[`${srv.url}|coll-1`].serverUrl, srv.url);
  assert.equal(conn.requests.length, 0, 'no connector probe');
});

// The server has claimed the code and minted the token by the time the
// credential is written: a failure there is a message, not a crash.
test('CLI: a credential that cannot be saved after the exchange fails with a message, not a stack trace', async (t) => {
  const srv = await literati(t);
  const { home, cwd } = cliEnv(t);
  writeFileSync(join(home, '.literati'), ''); // a file where the directory must go

  const r = await run(['complete', 'K7QM2XPT'], { home, cwd, url: srv.url, connectorUrl: await deadServer() });

  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /Paired, but the credential could not be saved: /);
  // The lib says the code is spent; the CLI adds where the next one comes from.
  assert.match(r.stderr, /The code is spent; fix that first\. Create a new code at https:\/\/app\.example\.test\/pair and run `login\.mjs complete <code>` here\./);
  assert.doesNotMatch(r.stderr, /pair again/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'a message, not a stack trace');
  assert.doesNotMatch(r.stdout, /Logged in/);
  assert.equal(exchanges(srv).length, 1);
});

test('CLI: a malformed code is refused before any request', async (t) => {
  const srv = await literati(t);
  const { home, cwd } = cliEnv(t);

  const r = await run(['complete', 'abc'], { home, cwd, url: srv.url, connectorUrl: await deadServer() });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /doesn't look like a Literati pairing code/);
  assert.equal(srv.requests.length, 0);
  const missing = await run(['complete'], { home, cwd, url: srv.url, connectorUrl: await deadServer() });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Usage: login\.mjs <start \[project-url\] \| complete <code> \| status>/);
});

// The lib runs in a child here on purpose: lib/credentials.mjs resolves
// ~/.literati at import time, so an in-process exchange would write to the
// developer's real credential store, and "nothing saved" would prove nothing.
test('CLI: every server refusal gets the matching advice, and nothing is saved', async (t) => {
  // A proxy's answer: a status and an HTML page, no JSON.
  const html = (res, status) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body>Bad gateway</body></html>');
  };
  const srv = await literati(t, {
    'POST /cli/pairing/exchange': (body, res) => {
      switch (body?.code) {
        case 'AMBGUAMB': res.statusCode = 409; return { code: 'PAIRING_CODE_AMBIGUOUS' };
        case 'USEDUSED': res.statusCode = 409; return { code: 'PAIRING_NOT_EXCHANGEABLE' };
        case 'ATTEMPT5': res.statusCode = 429; return { error: 'Too many attempts', code: 'PAIRING_TOO_MANY_ATTEMPTS' };
        case 'LMTDLMTD': res.statusCode = 429; return { error: 'Too many requests', code: 'RATE_LIMITED', retryAfterSeconds: 42 };
        case 'RTRYBARE': res.statusCode = 429; return { error: 'Too many requests', code: 'RATE_LIMITED' };
        case 'RTRYHDR7': res.setHeader('Retry-After', '37'); return html(res, 429);
        case 'HTMLGATE': return html(res, 502);
        case 'ELDSRV44': res.statusCode = 404; return { error: 'Not Found' }; // a server without the route
        case 'PRJGNE44': res.statusCode = 404; return { error: 'Project not found', code: 'PAIRING_PROJECT_GONE' };
        case 'RWGNE444': res.statusCode = 404; return { error: 'Not found', code: 'PAIRING_NOT_FOUND' };
        case 'EMPTYBDY': return {}; // a 200 that is not the token
        case 'NULLBDY2': return null;
        case 'HTMLBDY2': return html(res, 200); // a captive portal's page
        case 'TKNCPTKN': res.statusCode = 400; return { error: 'Too many CLI tokens — revoke one first', code: 'CLI_TOKEN_LIMIT' };
        default: res.statusCode = 400; return { error: 'Invalid or expired code', code: 'PAIRING_INVALID_CODE' };
      }
    },
  });
  const page = new RegExp(`${WEB}/pair`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  const sameCode = /here with the same code/;
  const newCode = /Create a new code at/;
  // [code, message, advice that must follow, advice that must not]
  const cases = [
    ['WRNGCDE2', /not correct, or it expired or was already used/, [/Check the code/, page], [sameCode, newCode]],
    ['AMBGUAMB', /not unique/, [newCode, page], [sameCode]],
    ['USEDUSED', /already used or cancelled/, [newCode, page], [sameCode]],
    ['ATTEMPT5', /Pairing could not be completed \(HTTP 429: the request is gone, or it had too many attempts\)/, [newCode, page], [sameCode]],
    // The token cap is checked before the code is claimed: it is still live.
    ['TKNCPTKN', /CLI & agent tokens/, [sameCode], [newCode, page]],
    // A rate limit never sends the user back to the page: the code is still good.
    ['LMTDLMTD', /Try again in 42 seconds/, [sameCode], [newCode, page]],
    ['RTRYBARE', /Try again in a few minutes/, [sameCode], [newCode, page]],
    ['RTRYHDR7', /Try again in 37 seconds/, [sameCode], [newCode, page]],
    ['HTMLGATE', /server returned an error \(HTTP 502\)/, [sameCode], [newCode, page]],
    // A server without the route is named (a wrong LITERATI_SERVER_URL 404s the
    // same way); no code can help, and the user is not sent to the app "instead".
    ['ELDSRV44', /does not support pairing codes: it needs an update, or LITERATI_SERVER_URL is not the Literati API/, [lit(`(${srv.url})`), /only the Literati desktop app can pair with it \(download: https:\/\/literati\.ai\/download\)\.$/m], [/same code/, newCode, page, /instead/]],
    // The project was deleted after the code was minted: no code can help with it.
    ['PRJGNE44', /no longer exists\. Pick another project on the pairing page and create a new code\.$/m, [], [/same code/, newCode, page]],
    ['RWGNE444', /Pairing could not be completed \(HTTP 404: the request is gone, or it had too many attempts\)/, [newCode, page], [sameCode]],
    // A 200 without a token is not a login: nothing saved, and the code is still good.
    ['EMPTYBDY', /sent an unexpected reply/, [sameCode], [newCode, page, /Logged in/]],
    ['NULLBDY2', /sent an unexpected reply/, [sameCode], [newCode, page, /Logged in/]],
    ['HTMLBDY2', /sent an unexpected reply/, [sameCode], [newCode, page, /Logged in/]],
  ];
  for (const [code, message, advice, not] of cases) {
    const { home, cwd } = cliEnv(t);
    const r = await run(['complete', code], { home, cwd, url: srv.url, connectorUrl: await deadServer() });
    assert.equal(r.status, 1, code);
    assert.match(r.stderr, message, code);
    for (const re of advice) assert.match(r.stderr, re, code);
    for (const re of not) assert.doesNotMatch(r.stderr, re, code);
    assert.doesNotMatch(r.stderr + r.stdout, /SyntaxError|TypeError|\n\s+at /, `${code}: a message, not a stack trace`);
    assert.ok(!existsSync(join(home, '.literati', 'credentials.json')), `${code}: nothing saved`);
    assert.equal(srv.requests.filter((s) => s.body?.code === code).length, 1, `${code}: sent once, no client-side retry`);
  }
});

test('CLI: an unreachable server says to retry the same code, not to mint another', async (t) => {
  const { home, cwd } = cliEnv(t);
  const r = await run(['complete', 'K7QM2XPT'], { home, cwd, url: await deadServer(), connectorUrl: await deadServer() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Could not reach the Literati server: [^\n]*[^.]\. Then run/, 'the error ends in one period, then the advice');
  assert.match(r.stderr, /Could not reach the Literati server: ECONNREFUSED\./, 'the cause, not "fetch failed"');
  assert.match(r.stderr, /with the same code/);
  assert.doesNotMatch(r.stderr, /Create a new code/);
  assert.ok(!existsSync(join(home, '.literati', 'credentials.json')));
});

test('CLI: a wrong or expired code fails with the retry path and saves nothing', async (t) => {
  const srv = await literati(t);
  const { home, cwd } = cliEnv(t);

  const r = await run(['complete', 'WRNGCDE2'], { home, cwd, url: srv.url, connectorUrl: await deadServer() });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /not correct, or it expired or was already used/);
  assert.match(r.stderr, /Check the code/, 'a mistyped code is still live: check it before minting another');
  assert.match(r.stderr, new RegExp(`${WEB}/pair`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.match(r.stderr, /login\.mjs complete <code>/);
  assert.ok(!existsSync(join(home, '.literati', 'credentials.json')));
});

test('CLI: start with no desktop app names the pairing page and the paste step instead of only refusing', async (t) => {
  const srv = await literati(t);
  const { home, cwd } = cliEnv(t);

  // Reachable but no /cli-pair/hello (404), like an older app: `unavailable` at
  // once. A dead port would make the CLI run `open literati://cli-pair`, which
  // launches the real desktop app on the machine running the tests.
  const noApp = await stubServer(t, {});
  const r = await run(['start'], { home, cwd, url: srv.url, connectorUrl: noApp.url });

  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`${WEB}/pair`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.match(r.stderr, /login\.mjs complete <code>/);
  assert.match(r.stderr, /type a machine name and copy the 8-character code it shows, then run `login\.mjs complete <code>` here\./);
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
  assert.match(textOf(results[0]), /check the code/);
  assert.match(textOf(results[0]), /\/pair/);
  assert.match(textOf(results[0]), /literati_login/);
  assert.match(
    textOf(results[0]),
    /Ask the user to check the code, then call literati_login again with it as `code`; only if it expired or was already used, they create a new one at https:\/\/app\.example\.test\/pair first\.$/,
  );
  assert.equal(results[1].isError, true);
  assert.match(textOf(results[1]), /doesn't look like a Literati pairing code/);
  assert.match(textOf(results[1]), /never 0, O, 1 or I/, 'the alphabet is spelled out, so a hand-typist can tell what to fix');
  assert.match(textOf(results[1]), /Ask the user to copy it from the pairing page, then call literati_login again with that code as `code`\.$/);
  assert.equal(exchanges(srv).length, 1, 'the malformed code was not sent');
  assert.equal(conn.requests.length, 0);
  assert.ok(!existsSync(join(home, '.literati', 'credentials.json')));
});

test('MCP: exchange failures advise by reason — rate limited, an unreachable server and an empty 200 keep the code, the attempt cap needs a new one', { timeout: 30_000 }, async (t) => {
  const srv = await mcpLiterati(t, {
    'POST /cli/pairing/exchange': (body, res) => {
      if (body?.code === 'EMPTYBDY') return {}; // a 200 that is not the token
      res.statusCode = 429;
      if (body?.code === 'LMTDLMTD') return { error: 'Too many requests', code: 'RATE_LIMITED', retryAfterSeconds: 42 };
      return { error: 'Too many attempts', code: 'PAIRING_TOO_MANY_ATTEMPTS' };
    },
  });
  const conn = await stubServer(t, {});
  const env = { LITERATI_CONNECTOR_URL: conn.url };
  const page = new RegExp(`${WEB}/pair`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  const home = tempHome(t);
  const { results } = await session(
    home,
    'claude-code',
    [
      callTool('literati_login', { code: 'LMTDLMTD' }),
      callTool('literati_login', { code: 'ATTEMPT5' }),
      callTool('literati_login', { code: 'EMPTYBDY' }),
    ],
    { serverUrl: srv.url, env },
  );
  assert.ok(results[2], 'an empty 200 is a tool result, not a protocol error');
  assert.equal(results[2].isError, true);
  assert.match(textOf(results[2]), /sent an unexpected reply/);
  assert.match(textOf(results[2]), /Then call literati_login with the same `code`\.$/);
  assert.ok(!existsSync(join(home, '.literati', 'credentials.json')), 'nothing saved from an empty 200');
  assert.equal(results[0].isError, true);
  assert.match(textOf(results[0]), /Try again in 42 seconds/);
  assert.match(textOf(results[0]), /Then call literati_login with the same `code`\.$/);
  assert.doesNotMatch(textOf(results[0]), /create a new code/i);
  assert.doesNotMatch(textOf(results[0]), page);
  assert.equal(results[1].isError, true);
  assert.match(textOf(results[1]), /Pairing could not be completed \(HTTP 429: /);
  assert.match(textOf(results[1]), /create a new code/);
  assert.match(textOf(results[1]), page);
  assert.match(textOf(results[1]), /Ask the user to create a new code at https:\/\/app\.example\.test\/pair, then call literati_login again with that code as `code`\.$/);
  assert.doesNotMatch(textOf(results[1]), /same `code`/);
  // Nothing listening: the same code again, and no trip to the page.
  const down = await session(tempHome(t), 'claude-code', [callTool('literati_login', { code: 'K7QM2XPT' })], { serverUrl: await deadServer(), env });
  assert.equal(down.results[0].isError, true);
  assert.match(textOf(down.results[0]), /Could not reach the Literati server: ECONNREFUSED\. Then call literati_login with the same `code`\.$/);
  assert.doesNotMatch(textOf(down.results[0]), /create a new code/i);
  assert.equal(conn.requests.length, 0);
});

test('MCP: a blank code with a code in project_url exchanges it; an explicit code wins over project_url', { timeout: 30_000 }, async (t) => {
  const srv = await mcpLiterati(t);
  const conn = await stubServer(t, {});
  const { results } = await session(
    tempHome(t),
    'claude-code',
    [
      callTool('literati_login', { code: '', project_url: 'K7QM2XPT' }),
      callTool('literati_login', { code: 'WRNGCDE2', project_url: 'K7QM2XPT' }),
    ],
    { serverUrl: srv.url, env: { LITERATI_CONNECTOR_URL: conn.url } },
  );
  assert.equal(results[0].isError, false, textOf(results[0]));
  assert.match(textOf(results[0]), /Logged in to Literati project "Web Project"/);
  assert.equal(results[1].isError, true);
  assert.match(textOf(results[1]), /not correct, or it expired or was already used/);
  assert.deepEqual(exchanges(srv).map((ex) => ex.body), [{ code: 'K7QM2XPT' }, { code: 'WRNGCDE2' }]);
  assert.equal(conn.requests.length, 0, 'a blank code never hands the code to the desktop app as a project');
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
  assert.match(textOf(results[0]), /type a machine name and copy the 8-character code it shows, then call literati_login again with that code as `code`\./);
  assert.match(textOf(results[0]), /https:\/\/literati\.ai\/download/);
  assert.ok(!srv.requests.some((r) => r.url.startsWith('/cli/pairing')), 'no pairing request without a code');
});

test('MCP: a trailing slash in LITERATI_SERVER_URL is dropped: the exchange path is /cli/pairing/exchange and the saved serverUrl has none', { timeout: 30_000 }, async (t) => {
  const srv = await mcpLiterati(t);
  const conn = await stubServer(t, {});
  const home = tempHome(t);
  const { results } = await session(home, 'claude-code', [callTool('literati_login', { code: 'K7QM2XPT' })], {
    serverUrl: `${srv.url}/`,
    env: { LITERATI_CONNECTOR_URL: conn.url },
  });
  assert.equal(results[0].isError, false, textOf(results[0]));
  assert.match(textOf(results[0]), /Logged in to Literati project "Web Project"/);
  assert.deepEqual(srv.requests.filter((s) => s.method === 'POST').map((s) => s.url), ['/cli/pairing/exchange']);
  const creds = JSON.parse(readFileSync(join(home, '.literati', 'credentials.json'), 'utf8'));
  assert.equal(creds.projects[`${srv.url}|coll-1`]?.serverUrl, srv.url);
  assert.equal(conn.requests.length, 0, 'no connector probe');
});

test('MCP: a server without the route and a deleted project get the whole message and no next step; a gone request gets the new-code advice', { timeout: 30_000 }, async (t) => {
  const env = { LITERATI_CONNECTOR_URL: (await stubServer(t, {})).url };
  // No exchange route at all: the stub's bare 404, like a server that predates pairing by code.
  const older = await stubServer(t, { 'GET /config/public': { whitelistGateEnabled: false, webAppUrl: WEB } });
  const old = await session(tempHome(t), 'claude-code', [callTool('literati_login', { code: 'ELDSRV44' })], { serverUrl: older.url, env });
  assert.equal(old.results[0].isError, true);
  assert.equal(
    textOf(old.results[0]),
    `This Literati server (${older.url}) does not support pairing codes: it needs an update, or LITERATI_SERVER_URL is not the Literati API. Until it is updated, only the Literati desktop app can pair with it (download: https://literati.ai/download).`,
  );

  const srv = await mcpLiterati(t, {
    'POST /cli/pairing/exchange': (body, res) => {
      res.statusCode = 404;
      return body?.code === 'PRJGNE44'
        ? { error: 'Project not found', code: 'PAIRING_PROJECT_GONE' }
        : { error: 'Not found', code: 'PAIRING_NOT_FOUND' };
    },
  });
  const { results } = await session(
    tempHome(t),
    'claude-code',
    [callTool('literati_login', { code: 'PRJGNE44' }), callTool('literati_login', { code: 'RWGNE444' })],
    { serverUrl: srv.url, env },
  );
  assert.equal(results[0].isError, true);
  assert.equal(textOf(results[0]), 'The project this code was for no longer exists. Pick another project on the pairing page and create a new code.');
  assert.equal(results[1].isError, true);
  assert.equal(
    textOf(results[1]),
    `Pairing could not be completed (HTTP 404: the request is gone, or it had too many attempts). Ask the user to create a new code at ${WEB}/pair, then call literati_login again with that code as \`code\`.`,
  );
});

test('MCP: the login tool takes an optional code and its description says when to use it', { timeout: 30_000 }, async (t) => {
  const { results } = await session(tempHome(t), 'claude-code', [['tools/list', {}]]);
  const login = results[0].tools.find((tool) => tool.name === 'literati_login');
  assert.ok(login);
  assert.deepEqual(Object.keys(login.inputSchema.properties).sort(), ['code', 'project_url']);
  assert.match(login.description, /ask them for that code and call this tool again with it as `code`/);
  assert.match(login.inputSchema.properties.project_url.description, /Ignored when `code` is given \(the project was chosen on the pairing page\)\.$/);
});
