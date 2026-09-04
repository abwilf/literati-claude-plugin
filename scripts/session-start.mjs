#!/usr/bin/env node
// SessionStart hook: inject Literati working context for this directory.
// Paired → project name + paper count + current file list (the dynamic
// counterpart of the static MCP `instructions`). Not paired → tell Claude to
// offer the login flow. Always exits 0; on any error it emits nothing.
//
// Also maintains the stable MCP bundle copy at ~/.literati/mcp/bundle.mjs:
// the `literati` MCP server is registered at USER scope (not declared by
// this plugin) so tools display as `literati - <tool> (MCP)` instead of
// `plugin:literati:tools`. The plugin install dir is versioned/ephemeral, so
// the registration points at ~/.literati/mcp/bundle.mjs and this hook
// refreshes that copy whenever the plugin version changes (or the copy is
// missing). The hook only ever writes under ~/.literati — registering the
// server (which edits ~/.claude.json) is done by the user-approved
// /literati:login flow, never silently by a hook.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getCredentialForDir, LITERATI_DIR } from '../lib/credentials.mjs';

// First-session-after-install marker: the full welcome fires exactly once
// per machine; later unpaired sessions get the shorter login nudge.
const WELCOMED_MARKER = join(LITERATI_DIR, 'welcomed');

// Resolved from this script's own location — CLAUDE_PLUGIN_ROOT is not
// guaranteed in the hook's env.
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MCP_DIR = join(LITERATI_DIR, 'mcp');
const BUNDLE_DEST = join(MCP_DIR, 'bundle.mjs');
const MANIFEST_PATH = join(MCP_DIR, 'manifest.json');

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function sha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** Copy the bundled MCP server to its stable path when its CONTENT differs from
 * the copy we last made (or the copy is missing — self-healing if ~/.literati
 * was wiped). Compared by hash rather than plugin version: a maintainer who
 * rebuilds the bundle without bumping the version would otherwise keep loading
 * the stale copy with no indication. Atomic (tmp + rename) so a concurrently
 * starting server never loads a half-written file. Best-effort: any failure
 * leaves the old copy in place. */
function refreshBundle() {
  try {
    const src = join(PLUGIN_ROOT, 'mcp', 'bundle.mjs');
    const srcHash = sha256(src);
    if (!srcHash) return;
    let current = null;
    try {
      current = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).sha256 ?? null;
    } catch {
      /* no manifest yet, or one written before hashes were recorded */
    }
    if (existsSync(BUNDLE_DEST) && current === srcHash) return;
    mkdirSync(MCP_DIR, { recursive: true });
    const tmp = `${BUNDLE_DEST}.tmp`;
    copyFileSync(src, tmp);
    renameSync(tmp, BUNDLE_DEST);
    writeFileSync(
      MANIFEST_PATH,
      JSON.stringify({ version: pluginVersion(), sha256: srcHash, copiedAt: new Date().toISOString() }) + '\n',
    );
  } catch {
    /* best effort */
  }
}

/** Claude Code's user config file — the one `claude mcp add --scope user`
 * writes. Honour CLAUDE_CONFIG_DIR the way Claude Code does, else the hook
 * reads the real ~/.claude.json while an isolated config has no server. */
function claudeConfigPath(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
}

/** Is the user-scope `literati` MCP server registered and pointing at the
 * stable bundle copy? Read-only peek at the Claude Code user config. */
function mcpServerRegistered() {
  try {
    const cfg = JSON.parse(readFileSync(claudeConfigPath(), 'utf8'));
    const entry = cfg?.mcpServers?.literati;
    if (!entry) return false;
    const parts = [entry.command, ...(entry.args ?? [])].join(' ');
    return parts.includes(join('.literati', 'mcp', 'bundle.mjs'));
  } catch {
    return false;
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
  // The write callback fires once the data has been handed to the OS, so
  // exiting from it cannot truncate the pipe the way a bare process.exit()
  // would. Exiting explicitly matters: a fetch aborted by its timeout leaves a
  // socket holding the event loop open for ~10s (undici's connect timeout),
  // which Claude Code would spend waiting on this hook at every session start.
  process.stdout.write(
    JSON.stringify({
      ...(systemMessage ? { systemMessage } : {}),
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    }),
    () => process.exit(0),
  );
}

// First-run banner: shown to the USER directly (systemMessage renders in the
// UI) — not spoken by the model.
const WELCOME_BANNER = `Welcome to the Literati for Claude Code plugin! 🎉

This plugin lets you work on Literati research project files right from Claude Code - read and edit your LaTeX files, compile and debug the PDF, search for and add papers to your bibliography, stage and commit, all synced in real time and viewable by yourself and your collaborators on the web & desktop apps. Claude operates on your behalf - each edit appears as your own. This should feel like using Claude Code on your own filesystem, but have all the benefits of real-time collaboration that Literati offers on the server side.

To get connected, run /literati:login (or just paste your *Literati project URL* — you'll find it on the project page in the Literati web app). Claude will register the Literati tools, kick off the login (you'll approve it in the web app and drop a one-time code back here), and tell you when to restart. Logins are directory-specific: pair each project directory once.

This message only appears once. Claude can answer any additional questions you have about how to use it.`;

async function main() {
  const payload = JSON.parse(readStdin() || '{}');
  refreshBundle();
  const registered = mcpServerRegistered();
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
          'The user just installed the Literati plugin and was shown a one-time welcome banner (by the system, not you) explaining the plugin and pointing them at /literati:login. Do NOT repeat the welcome.',
          'If their message contains a Literati project URL (or a project id/slug), run the /literati:login flow with it (it registers the user-scope `literati` MCP server and completes pairing via the plugin\'s scripts/login.mjs).',
          'If they ask questions about the plugin, answer them; otherwise help with whatever they came to do and mention they can connect anytime via /literati:login.',
        ].join('\n'),
        WELCOME_BANNER,
      );
      return;
    }
    emit(
      [
        'The Literati plugin is installed but this directory is not yet paired with a Literati project, so Literati tools will not work.',
        registered
          ? 'When the user first asks for anything Literati-related (or at the start of the conversation if they seem to be here for Literati), offer to log them in: ask for their Literati project URL, then run the /literati:login flow.'
          : 'The `literati` MCP server is also not registered yet. When the user wants Literati, run the /literati:login flow — it registers the server and pairs this directory.',
      ].join('\n'),
    );
    return;
  }

  if (!registered) {
    // Paired but no user-scope registration: an upgrader from plugin ≤0.5.2
    // (which declared the MCP server inside the plugin), a wiped
    // ~/.claude.json, or a different CLAUDE_CONFIG_DIR. One /literati:login
    // run fixes it (pairing is kept). No tools are loaded in this session, so
    // the model must not be told they are.
    emit(
      [
        `This directory is paired with the Literati project "${cred.projectName}", but the user-scope \`literati\` MCP server is not registered in this Claude Code config, so NO \`mcp__literati__*\` tools are available in this session — do not look for or call them.`,
        'When the user wants Literati, run the /literati:login flow: its first step registers the server (the pairing is kept), then tell the user to restart Claude Code to load the tools.',
      ].join('\n'),
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
