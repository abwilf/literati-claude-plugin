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
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

export const LITERATI_DIR = join(homedir(), '.literati');
export const CREDENTIALS_PATH = join(LITERATI_DIR, 'credentials.json');
export const SESSIONS_DIR = join(LITERATI_DIR, 'sessions');

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
