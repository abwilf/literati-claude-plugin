#!/usr/bin/env node
// SessionStart hook: inject Literati working context for this directory.
// Paired → project name + paper count + current file list (the dynamic
// counterpart of the static MCP `instructions`). Not paired → tell Claude to
// offer the login flow. Always exits 0; on any error it emits nothing.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCredentialForDir, LITERATI_DIR } from '../lib/credentials.mjs';

// First-session-after-install marker: the full welcome fires exactly once
// per machine; later unpaired sessions get the shorter login nudge.
const WELCOMED_MARKER = join(LITERATI_DIR, 'welcomed');

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
    if (!existsSync(WELCOMED_MARKER)) {
      try {
        mkdirSync(LITERATI_DIR, { recursive: true });
        writeFileSync(WELCOMED_MARKER, new Date().toISOString());
      } catch {
        /* best effort */
      }
      emit(
        [
          'The user has JUST INSTALLED the Literati plugin and this is their first session with it. Open your very first reply with a short, warm welcome (before addressing anything else they said):',
          '1. Welcome them to Literati for Claude Code.',
          "2. One-breath overview of what it does: work on a Literati research project's files from Claude Code — read/edit LaTeX sources, compile and debug the PDF, search and add papers to the bibliography, and every session syncs back to Literati so they can resume it in the app.",
          '3. Then get them connected: ask for their Literati project URL (from the project page in the Literati web app). When they provide it, call the literati_login tool and follow its instructions (they approve in the web app, then paste a one-time code here).',
          'Keep it to a few friendly sentences, not a wall of text. If they clearly came to do something unrelated to Literati, keep the welcome to one line and offer to set up later.',
        ].join('\n'),
      );
      return;
    }
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
