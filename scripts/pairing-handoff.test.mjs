// The first-install flow starts a pairing in `scripts/login.mjs` and finishes
// it in the MCP server — two processes. The pending request must therefore
// survive on disk, not only in the memory of whichever process created it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CREDENTIALS = fileURLToPath(new URL('../lib/credentials.mjs', import.meta.url));

/** Run a snippet in a FRESH node process with an isolated HOME. */
function inProcess(home, body) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import {savePendingPairing,loadPendingPairing,clearPendingPairing,PENDING_PATH} from ${JSON.stringify(CREDENTIALS)};${body}`], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('a pairing saved by one process is readable by another', () => {
  const home = mkdtempSync(join(tmpdir(), 'literati-handoff-'));
  try {
    inProcess(home, `savePendingPairing({requestId:'req-1',serverUrl:'https://api.literati.ai'});`);
    assert.ok(existsSync(join(home, '.literati', 'pairing-pending.json')));

    const seen = inProcess(home, `const p=loadPendingPairing();console.log(JSON.stringify(p));`);
    const parsed = JSON.parse(seen);
    assert.equal(parsed.requestId, 'req-1');
    assert.equal(parsed.serverUrl, 'https://api.literati.ai');

    const after = inProcess(home, `clearPendingPairing();console.log(JSON.stringify(loadPendingPairing()));`);
    assert.equal(after, 'null');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('no pairing on disk reads back as null, not a throw', () => {
  const home = mkdtempSync(join(tmpdir(), 'literati-handoff-'));
  try {
    assert.equal(inProcess(home, `console.log(JSON.stringify(loadPendingPairing()));`), 'null');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
