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

function emit(additionalContext, systemMessage) {
  process.stdout.write(
    JSON.stringify({
      ...(systemMessage ? { systemMessage } : {}),
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    }),
  );
}

// First-run banner: shown to the USER directly (systemMessage renders in the
// UI) — not spoken by the model.
const WELCOME_BANNER = `Welcome to the Literati for Claude Code plugin! 🎉

This plugin lets you work on Literati research project files right from Claude Code - read and edit your LaTeX files, compile and debug the PDF, search for and add papers to your bibliography, stage and commit, all synced in real time and viewable by yourself and your collaborators on the web & desktop apps. Claude operates on your behalf - each edit appears as your own. This should feel like using Claude Code on your own filesystem, but have all the benefits of real-time collaboration that Literati offers on the server side.

To get you connected, could you share your *Literati project URL*? You'll find it on the project page in the Literati web app. Once you paste it here, I'll kick off the login (you'll approve it in the web app, then drop a one-time code back here). This will store a directory-specific key (if you move to another directory, you'll either need to re-log in or copy another key).

This message only appears once. Claude can answer any additional questions you have about how to use it.`;

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
          'The user just installed the Literati plugin and was shown a one-time welcome banner (by the system, not you) explaining the plugin and asking them to paste their Literati project URL to connect. Do NOT repeat the welcome.',
          'If their message contains a Literati project URL (or a project id/slug), call the literati_login tool with it and follow its instructions (they approve in the Literati web app, then paste a one-time code here → literati_login_code).',
          'If they ask questions about the plugin, answer them; otherwise help with whatever they came to do and mention they can connect anytime by sharing their project URL.',
        ].join('\n'),
        WELCOME_BANNER,
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

// No process.exit(): stdout writes to a pipe are ASYNC and exit() drops the
// unflushed buffer — Claude Code would receive truncated/empty hook output
// (welcome context silently lost). Natural termination drains stdout; all
// error paths are caught so the exit code is 0 either way.
main().catch(() => {
  process.exitCode = 0;
});
