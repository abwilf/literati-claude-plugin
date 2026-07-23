#!/usr/bin/env node
// SessionStart hook: inject Literati working context for this directory.
// Paired → project name + paper count + current file list (the dynamic
// counterpart of the static MCP `instructions`). Not paired → tell Claude to
// offer the login flow. Always exits 0; on any error it emits nothing.
import { readFileSync } from 'node:fs';
import { getCredentialForDir } from '../lib/credentials.mjs';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function fetchProjectContext(cred) {
  try {
    const res = await fetch(`${cred.serverUrl}/mcp-agent/context`, {
      headers: { Authorization: `Bearer ${cred.token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    }),
  );
}

async function main() {
  const payload = JSON.parse(readStdin() || '{}');
  const cred = getCredentialForDir(payload.cwd || process.cwd());
  if (!cred) {
    emit(
      'The Literati plugin is installed but this directory is not yet paired with a Literati project, so Literati tools will not work. When the user first asks for anything Literati-related (or at the start of the conversation if they seem to be here for Literati), offer to log them in: ask for their Literati project URL, then call the literati_login tool and follow its instructions.',
    );
    return;
  }

  const ctx = await fetchProjectContext(cred);
  const lines = [
    `This directory is paired with the Literati project "${ctx?.projectName ?? cred.projectName}". The Literati MCP tools (read, edit, compile, grep, papers, …) operate on that project's server-side files — not on local files.`,
  ];
  if (ctx) {
    if (typeof ctx.paperCount === 'number') {
      lines.push(`The project's paper library has ${ctx.paperCount} paper(s) (list_papers to enumerate).`);
    }
    if (Array.isArray(ctx.files) && ctx.files.length > 0) {
      lines.push(
        `Project files (as of session start — use list_files or grep if this looks stale): ${ctx.files.join(', ')}`,
      );
    }
  }
  emit(lines.join('\n'));
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
