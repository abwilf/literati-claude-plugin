// Runs the SessionStart hook as Claude Code does (subprocess, JSON on stdin)
// with HOME and CLAUDE_CONFIG_DIR pointed at temp dirs, and checks that the
// "is the user-scope `literati` server registered?" answer comes from the
// config file Claude Code is actually using. Run: `node --test scripts/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'session-start.mjs');
const REGISTERED = JSON.stringify({
  mcpServers: { literati: { command: 'node', args: ['/x/.literati/mcp/bundle.mjs'] } },
});

/** Fresh HOME (welcome already shown) + optional isolated config dir. */
function setup({ homeConfig, isolatedConfig, paired = false }) {
  const root = mkdtempSync(join(tmpdir(), 'literati-hook-'));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  mkdirSync(join(home, '.literati'), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(home, '.literati', 'welcomed'), 'x');
  if (homeConfig !== undefined) writeFileSync(join(home, '.claude.json'), homeConfig);
  if (paired) {
    writeFileSync(
      join(home, '.literati', 'credentials.json'),
      JSON.stringify({
        version: 1,
        projects: { 'http://127.0.0.1:9|c1': { serverUrl: 'http://127.0.0.1:9', token: 't', collectionId: 'c1', projectName: 'Proj' } },
        directories: { [cwd]: 'http://127.0.0.1:9|c1' },
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

test('paired directory + unregistered server: context denies tools and points at /literati:login', () => {
  const ctx = runHook(setup({ homeConfig: REGISTERED, isolatedConfig: '{}', paired: true }));
  assert.match(ctx, /paired with the Literati project "Proj"/);
  assert.match(ctx, /NO `mcp__literati__\*` tools are available/);
  assert.match(ctx, /\/literati:login/);
  assert.doesNotMatch(ctx, /operate on that project's server-side files/);
});
