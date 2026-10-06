// Codex packaging: Codex reads `.codex-plugin/plugin.json` (Claude Code ignores
// it) and from there `codex/mcp.json` + `codex/hooks.json`. These tests pin the
// rules that keep the two clients from interfering:
//   - no root `.mcp.json`, and the Claude manifest declares no server or hooks
//     (Claude Code would auto-start a SECOND server and double every tool),
//   - Codex hooks are SessionStart only (the shared hooks/hooks.json would
//     upload Codex transcripts as Claude Code ones),
//   - Codex runs its OWN bundle copy (~/.literati/mcp/codex/), never the one
//     Claude Code's user-scope server runs (~/.literati/mcp/bundle.mjs).
// Run: `node --test scripts/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(ROOT, 'scripts', 'codex-session-start.mjs');
const LAUNCHER = readFileSync(join(ROOT, 'scripts', 'codex-launcher.cjs'), 'utf8');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const server = () => readJson('codex/mcp.json').mcpServers.literati;

/** A throwaway HOME, removed after the test. */
function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'literati-codex-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('no root .mcp.json — Claude Code would start a second literati server', () => {
  assert.equal(existsSync(join(ROOT, '.mcp.json')), false);
});

test('the Claude manifest declares no MCP server and no hooks of its own', () => {
  const claude = readJson('.claude-plugin/plugin.json');
  assert.equal('mcpServers' in claude, false);
  assert.equal('hooks' in claude, false);
});

test('Codex manifest points at the Codex-only files and matches the Claude version', () => {
  const codex = readJson('.codex-plugin/plugin.json');
  const claude = readJson('.claude-plugin/plugin.json');
  assert.equal(codex.name, claude.name);
  assert.equal(codex.version, claude.version, 'bump both manifests together');
  assert.equal(codex.mcpServers, './codex/mcp.json');
  assert.equal(codex.hooks, './codex/hooks.json');
  // Codex turns commands/ into skills; login.md runs `claude mcp add`.
  assert.deepEqual(codex.commands, []);
});

test('Codex hooks are SessionStart only and run the Codex script on every platform', () => {
  const { hooks } = readJson('codex/hooks.json');
  assert.deepEqual(Object.keys(hooks), ['SessionStart']);
  const handlers = hooks.SessionStart.flatMap((m) => m.hooks);
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0].command, 'node "$PLUGIN_ROOT/scripts/codex-session-start.mjs"');
  assert.equal(handlers[0].commandWindows, 'node "%PLUGIN_ROOT%\\scripts\\codex-session-start.mjs"');
});

test('Codex server is the shell-free launcher, started in the session folder', () => {
  const s = server();
  assert.deepEqual(Object.keys(s).sort(), ['args', 'command', 'env_vars', 'startup_timeout_sec', 'tool_timeout_sec']);
  assert.equal(s.command, 'node');
  assert.deepEqual(s.args, ['-e', LAUNCHER], 'codex/mcp.json must embed scripts/codex-launcher.cjs verbatim');
  // No cwd: Codex then starts the server in the folder `codex` runs in, which
  // is how a folder resolves to its paired project.
  assert.equal('cwd' in s, false);
  // Codex passes MCP servers only an allowlisted environment.
  assert.deepEqual(s.env_vars, ['LITERATI_SERVER_URL', 'CODEX_HOME']);
});

/** Run the launcher as Codex would; `fake` bundles print where they ran from. */
function runLauncher(home, codexHome) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  if (codexHome) env.CODEX_HOME = codexHome;
  else delete env.CODEX_HOME;
  return spawnSync(process.execPath, ['-e', LAUNCHER], { cwd: home, env, encoding: 'utf8', timeout: 10_000 });
}

function fakeBundle(file, label) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `console.log(${JSON.stringify(label)} + ' ' + process.cwd());\n`);
}

test('launcher runs the hook-maintained copy, in the session folder', (t) => {
  const home = tempHome(t);
  fakeBundle(join(home, '.literati', 'mcp', 'codex', 'bundle.mjs'), 'copy');
  fakeBundle(join(home, '.codex', 'plugins', 'cache', 'literati', 'literati', '0.6.7', 'mcp', 'bundle.mjs'), 'cache');
  const r = runLauncher(home);
  assert.equal(r.status, 0, r.stderr);
  // The bundle resolves the paired project from its working directory.
  assert.equal(r.stdout.trim(), `copy ${realpathSync(home)}`);
});

test('launcher falls back to the newest cached bundle before the hook has run', (t) => {
  const home = tempHome(t);
  const codexHome = join(home, 'custom-codex-home');
  const older = join(codexHome, 'plugins', 'cache', 'literati', 'literati', '0.6.6', 'mcp', 'bundle.mjs');
  const newer = join(codexHome, 'plugins', 'cache', 'other-marketplace', 'literati', '0.6.7', 'mcp', 'bundle.mjs');
  fakeBundle(older, 'old');
  fakeBundle(newer, 'new');
  const past = new Date(Date.now() - 60_000);
  utimesSync(older, past, past);
  const r = runLauncher(home, codexHome);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^new /);
});

test('launcher explains itself when no bundle exists anywhere', (t) => {
  const home = tempHome(t);
  const r = runLauncher(home, join(home, 'missing'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Literati: MCP server bundle not found/);
});

function runHook(home) {
  const r = spawnSync(process.execPath, [HOOK], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: home }),
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'the hook must not inject context');
  return r;
}

test('hook copies the bundle to the Codex path only, then leaves an unchanged copy alone', (t) => {
  const home = tempHome(t);
  const dir = join(home, '.literati', 'mcp', 'codex');
  const dest = join(dir, 'bundle.mjs');

  runHook(home);
  assert.deepEqual(readFileSync(dest), readFileSync(join(ROOT, 'mcp', 'bundle.mjs')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).version, readJson('.codex-plugin/plugin.json').version);
  // Never Claude Code's copy, and no temp files left behind.
  assert.equal(existsSync(join(home, '.literati', 'mcp', 'bundle.mjs')), false);
  assert.deepEqual(readdirSync(dir).sort(), ['bundle.mjs', 'manifest.json']);

  const before = statSync(dest).mtimeMs;
  runHook(home);
  assert.equal(statSync(dest).mtimeMs, before);
});

test('hook replaces a stale copy', (t) => {
  const home = tempHome(t);
  const dir = join(home, '.literati', 'mcp', 'codex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bundle.mjs'), 'old\n');
  runHook(home);
  assert.deepEqual(readFileSync(join(dir, 'bundle.mjs')), readFileSync(join(ROOT, 'mcp', 'bundle.mjs')));
});

test('hook never fails the session when it cannot write, but says why on stderr', (t) => {
  const home = tempHome(t);
  // A FILE where the ~/.literati directory should be makes every write fail.
  writeFileSync(join(home, '.literati'), 'x');
  const r = runHook(home);
  assert.match(r.stderr, /Literati: could not update the Codex MCP bundle/);
});
