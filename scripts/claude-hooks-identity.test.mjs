// Claude Code's hooks (session-start context, transcript sync) talk to the
// Literati server too; like the MCP server they label themselves with
// X-Literati-Client so server-side labels and telemetry are complete.
// Run: `node --test scripts/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, tempHome, stubServer } from './mcp-test-helpers.mjs';

/** Run a hook script with `payload` on stdin. Async: the stub server shares this process. */
async function runHook(script, home, payload) {
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  const child = spawn(process.execPath, [join(ROOT, 'scripts', script)], {
    cwd: home,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify(payload));
  child.stdout.resume();
  child.stderr.resume();
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `${script} exited ${code}`);
}

test('session-start labels its project-context request claude-code', { timeout: 30_000 }, async (t) => {
  const server = await stubServer(t, {
    'GET /mcp-agent/context': { projectName: 'Proj', paperCount: 0, files: [] },
  });
  const home = tempHome(t, server.url);
  writeFileSync(join(home, '.literati', 'welcomed'), 'x');
  // Context is only fetched once the user-scope server is registered.
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ mcpServers: { literati: { command: 'node', args: [join(home, '.literati', 'mcp', 'bundle.mjs')] } } }),
  );
  await runHook('session-start.mjs', home, { cwd: home, hook_event_name: 'SessionStart' });
  const req = server.requests.find((r) => r.url === '/mcp-agent/context');
  assert.ok(req, 'context was not requested');
  assert.equal(req.headers['x-literati-client'], 'claude-code');
});

test('transcript sync labels its upload claude-code', { timeout: 30_000 }, async (t) => {
  const server = await stubServer(t, { 'POST /mcp-agent/transcript': { ok: true } });
  const home = tempHome(t, server.url);
  const transcript = join(home, 'session.jsonl');
  writeFileSync(transcript, '{"type":"user"}\n');
  await runHook('sync-transcript.mjs', home, {
    session_id: 's1',
    transcript_path: transcript,
    hook_event_name: 'PostToolUse',
    cwd: home,
  });
  const req = server.requests.find((r) => r.url === '/mcp-agent/transcript');
  assert.ok(req, 'transcript was not uploaded');
  assert.equal(req.headers['x-literati-client'], 'claude-code');
});
