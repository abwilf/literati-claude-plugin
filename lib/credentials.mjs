// Shared credential storage for the Literati MCP server and hook scripts.
// Plain Node (>=18), no dependencies — hook scripts must run without an
// npm install.
//
// Credentials persist in ~/.literati/credentials.json across sessions.
// Each pairing records the working directory it was performed from
// (`directories` map); opening Claude Code in that directory (or any
// subdirectory) automatically resolves the right project token. Directories
// with no binding are logged out — deliberately no machine-wide fallback, so
// a token never grants project access outside the directory tree the user
// explicitly paired.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

export const LITERATI_DIR = join(homedir(), '.literati');
export const CREDENTIALS_PATH = join(LITERATI_DIR, 'credentials.json');
export const SESSIONS_DIR = join(LITERATI_DIR, 'sessions');
export const PENDING_PATH = join(LITERATI_DIR, 'pairing-pending.json');

// In-flight pairing request, persisted so the pairing CLI and the MCP server
// can hand off to each other: on a first install `login.mjs start` creates the
// request (no MCP tools loaded yet) and the NEXT session finishes it with the
// `literati_login_code` tool, which is what fires sendToolListChanged() and so
// avoids a second restart. Single slot — starting a pairing replaces any
// in-flight one, so two simultaneous pairings are not supported.
//
// The record carries the directory the pairing was STARTED from: the resulting
// credential binds to that, not to wherever the code happens to be pasted, so
// finishing a pairing from another directory can't silently pair the wrong one.

/** Server-side pairing requests expire in 10 minutes; a stored request older
 * than that is treated as absent so it can't be resurrected days later. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

export function isPairingFresh(entry) {
  if (!entry?.requestId || !entry?.serverUrl) return false;
  const started = Date.parse(entry.createdAt ?? '');
  if (Number.isNaN(started)) return true; // no or unparseable timestamp: don't discard a usable request
  return Date.now() - started < PAIRING_TTL_MS;
}

/** Best-effort: never throws. The pairing request already exists server-side by
 * the time this runs, so a disk problem must not turn into a failed tool call.
 * @returns {boolean} whether the request was persisted */
export function savePendingPairing({ requestId, serverUrl, cwd }) {
  try {
    mkdirSync(LITERATI_DIR, { recursive: true });
    writeFileSync(
      PENDING_PATH,
      JSON.stringify({
        requestId,
        serverUrl,
        cwd: cwd ? resolve(cwd) : null,
        createdAt: new Date().toISOString(),
      }) + '\n',
    );
    try {
      chmodSync(PENDING_PATH, 0o600);
    } catch {
      /* best effort (e.g. Windows) */
    }
    return true;
  } catch {
    return false;
  }
}

/** @returns {{requestId:string, serverUrl:string, cwd:string|null, createdAt:string}|null} */
export function loadPendingPairing() {
  try {
    const entry = JSON.parse(readFileSync(PENDING_PATH, 'utf8'));
    return isPairingFresh(entry) ? entry : null;
  } catch {
    return null;
  }
}

export function clearPendingPairing() {
  try {
    unlinkSync(PENDING_PATH);
  } catch {
    /* best effort */
  }
}

export function projectKey(serverUrl, collectionId) {
  return `${serverUrl}|${collectionId}`;
}

/** @returns {{version:number, projects:Record<string,object>, directories:Record<string,string>}} */
export function loadCredentials() {
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.projects) {
      if (!parsed.directories) parsed.directories = {};
      return parsed;
    }
  } catch {
    /* missing or corrupt → start fresh */
  }
  return { version: 1, projects: {}, directories: {} };
}

export function saveCredentials(creds) {
  mkdirSync(LITERATI_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2) + '\n');
  try {
    chmodSync(CREDENTIALS_PATH, 0o600);
  } catch {
    /* best effort (e.g. Windows) */
  }
}

/**
 * Add/replace a project credential and bind it to the directory the pairing
 * was performed from.
 * entry: { serverUrl, token, collectionId, workspaceId, userId, projectSlug, projectName }
 */
export function addProjectCredential(entry, dir) {
  const creds = loadCredentials();
  const key = projectKey(entry.serverUrl, entry.collectionId);
  creds.projects[key] = { ...entry, createdAt: new Date().toISOString() };
  if (dir) creds.directories[resolve(dir)] = key;
  saveCredentials(creds);
  return key;
}

/**
 * Credential for a working directory: exact directory binding first, then
 * walking up parents (so a login done at a repo root covers its subdirs).
 * No binding → null (logged out) — never falls back to another directory's
 * project.
 */
export function getCredentialForDir(dir) {
  const creds = loadCredentials();
  let cur = dir ? resolve(dir) : null;
  while (cur) {
    const key = creds.directories[cur];
    if (key && creds.projects[key]) return creds.projects[key];
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
