// Runs the SessionStart hook as Claude Code does (subprocess, JSON on stdin)
// with HOME and CLAUDE_CONFIG_DIR pointed at temp dirs, and checks that the
// "is the user-scope `literati` server registered?" answer comes from the
// config file Claude Code is actually using. Run: `node --test scripts/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, stubServer } from './mcp-test-helpers.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'session-start.mjs');
const REGISTERED = JSON.stringify({
  mcpServers: { literati: { command: 'node', args: ['/x/.literati/mcp/bundle.mjs'] } },
});
const INSTALLED_VERSION = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;

/** Fresh HOME (welcome already shown) + optional isolated config dir. */
function setup({ homeConfig, isolatedConfig, paired = false, serverUrl = 'http://127.0.0.1:9' }) {
  const root = mkdtempSync(join(tmpdir(), 'literati-hook-'));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  mkdirSync(join(home, '.literati'), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(home, '.literati', 'welcomed'), 'x');
  if (homeConfig !== undefined) writeFileSync(join(home, '.claude.json'), homeConfig);
  if (paired) {
    const key = `${serverUrl}|c1`;
    writeFileSync(
      join(home, '.literati', 'credentials.json'),
      JSON.stringify({
        version: 1,
        projects: { [key]: { serverUrl, token: 't', collectionId: 'c1', projectName: 'Proj' } },
        directories: { [cwd]: key },
      }),
    );
  }
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  if (isolatedConfig !== undefined) {
    const cfgDir = join(root, 'cfg');
    mkdirSync(cfgDir);
    writeFileSync(join(cfgDir, '.claude.json'), isolatedConfig);
    env.CLAUDE_CONFIG_DIR = cfgDir;
  }
  return { cwd, env };
}

function runHook({ cwd, env }) {
  const r = spawnSync(process.execPath, [HOOK], { cwd, env, input: JSON.stringify({ cwd }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

/** Like runHook, but async: a stub server answering the hook runs in THIS process. */
async function runHookAsync({ cwd, env }) {
  const child = spawn(process.execPath, [HOOK], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(JSON.stringify({ cwd }));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

test('without CLAUDE_CONFIG_DIR the registration check reads ~/.claude.json', () => {
  const ctx = runHook(setup({ homeConfig: REGISTERED }));
  assert.doesNotMatch(ctx, /not registered/);
  assert.match(ctx, /offer to log them in/);
});

test('with CLAUDE_CONFIG_DIR the registration check reads that config, not ~/.claude.json', () => {
  const ctx = runHook(setup({ homeConfig: REGISTERED, isolatedConfig: '{}' }));
  assert.match(ctx, /not registered yet/);
  assert.match(ctx, /\/literati:login/);
});

test('paired directory + registered server: context names the project and routes pair / re-pair requests to login', () => {
  const ctx = runHook(setup({ homeConfig: REGISTERED, paired: true }));
  assert.match(ctx, /paired with the Literati project "Proj"/);
  assert.match(ctx, /operate on that project's server-side files/);
  // A user saying "pair" in a paired folder must get a new pairing, not
  // "already paired" answered from this very context.
  assert.match(ctx, /re-pair/);
  assert.match(ctx, /Do not answer that it is already paired/);
});

test('paired directory + unregistered server: context denies tools and points at /literati:login', () => {
  const ctx = runHook(setup({ homeConfig: REGISTERED, isolatedConfig: '{}', paired: true }));
  assert.match(ctx, /paired with the Literati project "Proj"/);
  assert.match(ctx, /NO `mcp__literati__\*` tools are available/);
  assert.match(ctx, /\/literati:login/);
  assert.doesNotMatch(ctx, /operate on that project's server-side files/);
});

// Stale-plugin nudge: the server reports the latest published plugin version
// in GET /mcp-agent/context; a NEWER one than the installed plugin.json gets
// one line telling the model to mention the update once.
const NUDGE = /A newer Literati plugin \((\d+\.\d+\.\d+)\) is available; this session runs (\d+\.\d+\.\d+)\. At the start of your first reply, tell the user once: update with `claude plugin update literati@literati` and restart Claude Code\. Then carry on with their request\./;

async function contextWith(t, extra) {
  const server = await stubServer(t, {
    'GET /mcp-agent/context': { projectName: 'Proj', paperCount: 0, files: [], ...extra },
  });
  const ctx = await runHookAsync(setup({ homeConfig: REGISTERED, paired: true, serverUrl: server.url }));
  // Proves the stub answered: a dead server would also yield "no nudge".
  assert.match(ctx, /paper library has 0 paper\(s\)/, ctx);
  return ctx;
}

const bump = (v, i) => v.split('.').map((n, j) => (j === i ? Number(n) + 1 : n)).join('.');

test('a newer plugin version on the server → the update nudge names both versions', { timeout: 30_000 }, async (t) => {
  assert.match(INSTALLED_VERSION, /^\d+\.\d+\.\d+$/, 'test assumes a plain semver in plugin.json');
  const newer = bump(INSTALLED_VERSION, 2);
  const ctx = await contextWith(t, { pluginVersion: newer });
  const m = ctx.match(NUDGE);
  assert.ok(m, ctx);
  assert.equal(m[1], newer);
  assert.equal(m[2], INSTALLED_VERSION);
  // The rest of the paired context is still there.
  assert.match(ctx, /paired with the Literati project "Proj"/);
});

test('a newer version is compared numerically per segment, not lexically', { timeout: 30_000 }, async (t) => {
  // e.g. installed 0.7.2 vs server 0.10.0: "10" sorts before "7" as a string.
  const [major, minor] = INSTALLED_VERSION.split('.');
  const ctx = await contextWith(t, { pluginVersion: `${major}.1${'0'.repeat(minor.length)}.0` });
  assert.match(ctx, NUDGE);
});

test('the same version → no nudge', { timeout: 30_000 }, async (t) => {
  const ctx = await contextWith(t, { pluginVersion: INSTALLED_VERSION });
  assert.doesNotMatch(ctx, /newer Literati plugin/);
});

test('an older version on the server → no nudge', { timeout: 30_000 }, async (t) => {
  // Decrement the last non-zero segment (0.7.2 → 0.7.1, 1.0.0 → 0.0.0).
  const parts = INSTALLED_VERSION.split('.').map(Number);
  const i = parts.findLastIndex((n) => n > 0);
  assert.ok(i >= 0, 'nothing is older than 0.0.0');
  parts[i] -= 1;
  const ctx = await contextWith(t, { pluginVersion: parts.join('.') });
  assert.doesNotMatch(ctx, /newer Literati plugin/);
});

test('no pluginVersion field, or a malformed one → no nudge', { timeout: 30_000 }, async (t) => {
  for (const extra of [{}, { pluginVersion: 'latest' }, { pluginVersion: 42 }, { pluginVersion: null }]) {
    const ctx = await contextWith(t, extra);
    assert.doesNotMatch(ctx, /newer Literati plugin/, JSON.stringify(extra));
  }
});
