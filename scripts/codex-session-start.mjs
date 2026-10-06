#!/usr/bin/env node
// Codex SessionStart hook: maintain a stable fallback copy of the MCP bundle.
//
// Codex does not expand ${PLUGIN_ROOT} in a plugin's MCP server config, so
// codex/mcp.json cannot point at mcp/bundle.mjs inside the (versioned) plugin
// install dir. The launcher there finds the installed bundle in Codex's plugin
// cache itself; should that cache ever not be where it expects, it runs this
// copy instead. Hooks do get the plugin root, so — the same trick the Claude
// Code hook uses — this copies the bundle to ~/.literati/mcp/codex/bundle.mjs.
//
// Deliberately NOT Claude Code's copy (~/.literati/mcp/bundle.mjs): with both
// clients installed at different plugin versions they would overwrite each
// other's bundle on every session start.
//
// Codex runs SessionStart hooks at the start of the first turn, after MCP
// servers have started, so this copy trails an update by a session — which is
// why the launcher prefers the cache. Always exits 0 and prints nothing to
// stdout; a failure gets one line on stderr.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LITERATI_DIR } from '../lib/credentials.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CODEX_MCP_DIR = join(LITERATI_DIR, 'mcp', 'codex');
const BUNDLE_DEST = join(CODEX_MCP_DIR, 'bundle.mjs');
const MANIFEST_PATH = join(CODEX_MCP_DIR, 'manifest.json');

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), 'utf8')).version ?? null;
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

/** Copy the bundle when its content differs from the copy we last made (or
 * the copy is missing). Atomic (tmp + rename) so a starting server never loads
 * a half-written file. Best-effort: any failure leaves the old copy in place. */
function refreshCodexBundle() {
  const tmp = `${BUNDLE_DEST}.tmp-${process.pid}`;
  try {
    const src = join(PLUGIN_ROOT, 'mcp', 'bundle.mjs');
    const srcHash = sha256(src);
    if (!srcHash) throw new Error(`cannot read ${src}`);
    if (existsSync(BUNDLE_DEST) && sha256(BUNDLE_DEST) === srcHash) return;
    mkdirSync(CODEX_MCP_DIR, { recursive: true });
    copyFileSync(src, tmp);
    renameSync(tmp, BUNDLE_DEST);
    writeFileSync(
      MANIFEST_PATH,
      JSON.stringify({ version: pluginVersion(), sha256: srcHash, copiedAt: new Date().toISOString() }) + '\n',
    );
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean up */
    }
    console.error(`Literati: could not update the Codex MCP bundle (${err.message}).`);
  }
}

refreshCodexBundle();
process.exit(0);
