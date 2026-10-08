#!/usr/bin/env node
// Regenerates mcp/tool-catalog.json — the tool list the MCP server advertises
// to clients that list tools only once per session (Codex) before the folder
// is paired. Fetched from a paired directory's server, so run it from (or
// pass) a directory paired against the server whose tools you want:
//
//   node scripts/snapshot-tool-catalog.mjs [paired-dir]
//   (cd mcp && npm run build)
//
// Regenerate whenever the server's /mcp-agent/tools list changes.
import { writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCredentialForDir } from '../lib/credentials.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = resolve(process.argv[2] ?? process.cwd());
const cred = getCredentialForDir(dir);
if (!cred) {
  console.error(`${dir} is not paired with a Literati project — pair it first, or pass a paired directory.`);
  process.exit(1);
}

const res = await fetch(`${cred.serverUrl}/mcp-agent/tools`, {
  headers: { Authorization: `Bearer ${cred.token}` },
  signal: AbortSignal.timeout(15_000),
});
if (!res.ok) {
  console.error(`GET ${cred.serverUrl}/mcp-agent/tools failed: HTTP ${res.status}`);
  process.exit(1);
}
const body = await res.json();
const tools = (Array.isArray(body.tools) ? body.tools : []).map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));
const malformed = tools.filter(
  (t) => typeof t.name !== 'string' || typeof t.description !== 'string' || t.inputSchema?.type !== 'object',
);
if (tools.length === 0 || malformed.length > 0) {
  console.error(
    tools.length === 0
      ? 'The server returned no tools — not overwriting the catalog.'
      : `Malformed tools in the server response (${malformed.map((t) => t.name).join(', ')}) — not overwriting the catalog.`,
  );
  process.exit(1);
}

// Only the date is recorded: the server URL would ship in the bundle and says
// nothing useful once the catalog is regenerated against production.
const out = join(ROOT, 'mcp', 'tool-catalog.json');
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), tools }, null, 2) + '\n');
console.log(`Wrote ${tools.length} tools from ${new URL(cred.serverUrl).host} to mcp/tool-catalog.json — now rebuild the bundle.`);
