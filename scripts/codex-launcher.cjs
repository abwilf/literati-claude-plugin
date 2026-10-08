// Codex MCP launcher — embedded verbatim as `node -e` in codex/mcp.json (keep them identical; codex-packaging.test.mjs checks). Shell-free so it also runs on Windows.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

// Runs the installed bundle from Codex's plugin cache
// (<CODEX_HOME>/plugins/cache/<marketplace>/literati/<version>/mcp/bundle.mjs),
// so an update takes effect in the very next session. The official
// marketplace ("literati", this repo's marketplace.json) wins over any other
// that also holds a literati plugin, e.g. a leftover test install; others are
// used only when it is absent. Within one, the highest version wins, ordered
// the way Codex orders them ("local" first, then semver, else plain string
// order) — never by file date, since Codex keeps the source files' dates on
// install. Should the cache not be where this expects, it runs the copy
// codex-session-start.mjs keeps.
const OFFICIAL_MARKETPLACE = 'literati';
const copy = path.join(os.homedir(), '.literati', 'mcp', 'codex', 'bundle.mjs');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (a === undefined) return 1; // a release ranks above its prereleases
  if (b === undefined) return -1;
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const xn = /^\d+$/.test(x[i]);
    const yn = /^\d+$/.test(y[i]);
    if (xn && yn && Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    if (!xn && x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

/** -1, 0 or 1, ordered the way Codex picks the active plugin version. */
function compareVersions(a, b) {
  if (a === b) return 0;
  if (a === 'local') return 1;
  if (b === 'local') return -1;
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return a > b ? 1 : -1;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]) ? 1 : -1;
  return comparePrerelease(x[4], y[4]);
}

/** The highest-version bundle under one marketplace, or null. */
function bestIn(cache, marketplace) {
  let best = null;
  let versions = [];
  try {
    versions = fs.readdirSync(path.join(cache, marketplace, 'literati'));
  } catch {
    return null;
  }
  for (const version of versions) {
    const file = path.join(cache, marketplace, 'literati', version, 'mcp', 'bundle.mjs');
    if (!fs.existsSync(file)) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { file, version };
  }
  return best;
}

function installedBundle() {
  const cache = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'plugins', 'cache');
  const official = bestIn(cache, OFFICIAL_MARKETPLACE);
  if (official) return official.file;
  let marketplaces = [];
  try {
    marketplaces = fs.readdirSync(cache);
  } catch {
    return null;
  }
  let best = null;
  for (const marketplace of marketplaces) {
    const found = bestIn(cache, marketplace);
    if (found && (!best || compareVersions(found.version, best.version) > 0)) best = found;
  }
  return best && best.file;
}

const bundle = installedBundle() || (fs.existsSync(copy) ? copy : null);
if (!bundle) {
  console.error('Literati: MCP server bundle not found. Reinstall the Literati plugin (codex plugin add literati@literati), then restart Codex.');
  process.exit(1);
}
import(pathToFileURL(bundle).href);
