// Codex MCP launcher — embedded verbatim as `node -e` in codex/mcp.json (keep them identical; codex-packaging.test.mjs checks). Shell-free so it also runs on Windows.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

// The copy codex-session-start.mjs maintains. Before that hook has ever run
// (first session after install, hook not yet trusted, `codex exec`), fall back
// to the newest bundle in Codex's plugin cache.
const copy = path.join(os.homedir(), '.literati', 'mcp', 'codex', 'bundle.mjs');

function newestCachedBundle() {
  const cache = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'plugins', 'cache');
  let best = null;
  let marketplaces = [];
  try {
    marketplaces = fs.readdirSync(cache);
  } catch {
    return null;
  }
  for (const marketplace of marketplaces) {
    let versions = [];
    try {
      versions = fs.readdirSync(path.join(cache, marketplace, 'literati'));
    } catch {
      continue;
    }
    for (const version of versions) {
      const file = path.join(cache, marketplace, 'literati', version, 'mcp', 'bundle.mjs');
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { file, mtime };
      } catch {
        /* not a plugin version dir */
      }
    }
  }
  return best && best.file;
}

const bundle = fs.existsSync(copy) ? copy : newestCachedBundle();
if (!bundle) {
  console.error('Literati: MCP server bundle not found. Reinstall the Literati plugin (codex plugin add literati@literati), approve its hook in /hooks, then restart Codex.');
  process.exit(1);
}
import(pathToFileURL(bundle).href);
