#!/usr/bin/env node
// Deterministic transcript sync hook for the Literati plugin.
//
// Wired (hooks/hooks.json) to:
//   - PostToolUse (matcher mcp__literati__.*): marks the session as
//     Literati-relevant and syncs.
//   - Stop: syncs only sessions previously marked — sessions that never
//     touched a Literati tool are NEVER uploaded.
//
// Reads the hook payload from stdin ({ session_id, transcript_path,
// hook_event_name }), POSTs the full session JSONL to
// <serverUrl>/mcp-agent/transcript (idempotent upsert keyed by session_id).
//
// ALWAYS exits 0 — a sync failure must never block Claude Code.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCredentialForDir, SESSIONS_DIR } from '../lib/credentials.mjs';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  const payload = JSON.parse(readStdin() || '{}');
  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  const event = payload.hook_event_name;
  if (!sessionId || !transcriptPath) return;

  // Session markers make the Stop-hook sync deterministic: PostToolUse only
  // fires on mcp__literati__* tools, so a marker file == "this session used
  // Literati".
  const marker = join(SESSIONS_DIR, sessionId);
  if (event === 'PostToolUse') {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(marker, new Date().toISOString());
  } else if (!existsSync(marker)) {
    return; // Stop (or unknown event) for a session that never used Literati
  }

  // Resolve the project by the session's working directory (hook payloads
  // carry `cwd`), falling back to the machine-wide default credential.
  const cred = getCredentialForDir(payload.cwd || process.cwd());
  if (!cred) return; // not logged in — nothing to sync to

  let transcript;
  try {
    transcript = readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    console.error(`[literati] cannot read transcript: ${err.message}`);
    return;
  }

  try {
    const res = await fetch(`${cred.serverUrl}/mcp-agent/transcript`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cred.token}`,
      },
      body: JSON.stringify({ claudeSessionId: sessionId, transcript }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      console.error(`[literati] transcript sync failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[literati] transcript sync failed: ${err.message}`);
  }
}

main()
  .catch((err) => console.error(`[literati] sync hook error: ${err.message}`))
  .finally(() => process.exit(0));
