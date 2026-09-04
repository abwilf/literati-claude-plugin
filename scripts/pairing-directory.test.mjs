// A pairing must bind to the directory it was STARTED from, even when the
// one-time code is supplied from somewhere else — the two halves of a
// first-install pairing routinely run in different sessions, and binding to
// whoever finishes it silently pairs the wrong directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOGIN = fileURLToPath(new URL('./login.mjs', import.meta.url));

function mockLiterati() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/cli/pairing/requests') return res.end(JSON.stringify({ requestId: 'req-1' }));
      if (req.url.endsWith('/exchange')) {
        if (JSON.parse(body || '{}').code !== 'GOODCODE') {
          res.statusCode = 400;
          return res.end(JSON.stringify({ code: 'PAIRING_INVALID_CODE' }));
        }
        return res.end(
          JSON.stringify({
            token: 'tok', collectionId: 'coll-1', workspaceId: 'ws', userId: 'u',
            projectSlug: 'slug', projectName: 'Test Project',
          }),
        );
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Must be async: the mock server runs in THIS process, so a synchronous spawn
// would block the event loop and the child's request would never be answered.
function run(args, { home, cwd, url }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [LOGIN, ...args], {
      cwd,
      env: { ...process.env, HOME: home, LITERATI_SERVER_URL: url },
    });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('the code may be pasted from another directory; the starting one is paired', async () => {
  const server = await mockLiterati();
  const url = `http://127.0.0.1:${server.address().port}`;
  const home = mkdtempSync(join(tmpdir(), 'literati-dir-'));
  const dirA = join(home, 'projectA');
  const dirB = join(home, 'elsewhere');
  mkdirSync(dirA); mkdirSync(dirB);
  try {
    const started = await run(['start', 'https://literati.ai/projects/abc'], { home, cwd: dirA, url });
    assert.equal(started.status, 0, started.stderr);

    // finish from a DIFFERENT directory
    const done = await run(['code', 'GOODCODE'], { home, cwd: dirB, url });
    assert.equal(done.status, 0, done.stderr);

    const creds = JSON.parse(readFileSync(join(home, '.literati', 'credentials.json'), 'utf8'));
    // realpath: macOS resolves /var -> /private/var, and the child records its own cwd
    assert.deepEqual(
      Object.keys(creds.directories),
      [realpathSync(dirA)],
      'must bind the directory that started the pairing',
    );
    assert.equal((await run(['status'], { home, cwd: dirA, url })).stdout.includes('Test Project'), true);
    assert.equal((await run(['status'], { home, cwd: dirB, url })).stdout.includes('not paired'), true);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a wrong code keeps the request; a terminal failure discards it', async () => {
  const server = await mockLiterati();
  const url = `http://127.0.0.1:${server.address().port}`;
  const home = mkdtempSync(join(tmpdir(), 'literati-dir-'));
  const dir = join(home, 'proj');
  mkdirSync(dir);
  const pending = join(home, '.literati', 'pairing-pending.json');
  try {
    await run(['start', 'https://literati.ai/projects/abc'], { home, cwd: dir, url });
    const bad = await run(['code', 'WRONG'], { home, cwd: dir, url });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not correct/);
    assert.ok(readFileSync(pending, 'utf8'), 'a retryable wrong code must keep the pending request');

    // retry with the right code still works
    assert.equal((await run(['code', 'GOODCODE'], { home, cwd: dir, url })).status, 0);
    assert.throws(() => readFileSync(pending, 'utf8'), 'success must clear the pending request');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
