// Shared harness for the stdio tests: runs the BUILT server (mcp/bundle.mjs)
// as a given MCP client in a throwaway HOME, and a stand-in Literati server.
// Not a test file itself (the runner only picks up *.test.mjs).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE = join(ROOT, 'mcp', 'bundle.mjs');
const REPLY_TIMEOUT_MS = 10_000;
export const DEAD_SERVER = 'http://127.0.0.1:9';

/** A throwaway HOME (removed after the test); optionally paired to `serverUrl`. */
export function tempHome(t, serverUrl) {
  // Real path: the server resolves pairing from process.cwd(), which is
  // symlink-resolved (macOS tmp is /var → /private/var).
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'literati-mcp-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (serverUrl) {
    mkdirSync(join(home, '.literati'));
    const key = `${serverUrl}|c1`;
    writeFileSync(
      join(home, '.literati', 'credentials.json'),
      JSON.stringify({
        version: 1,
        projects: { [key]: { serverUrl, token: 't', collectionId: 'c1', projectName: 'Proj' } },
        directories: { [home]: key },
      }),
    );
  }
  return home;
}

/**
 * Start the server as `clientName` in `home`, run `requests` in order.
 * Returns `{ init, results }` — the initialize result and each request's result.
 */
export async function session(home, clientName, requests, { serverUrl = DEAD_SERVER, env = {} } = {}) {
  const child = spawn(process.execPath, [BUNDLE], {
    cwd: home,
    // Unpaired calls resolve against this; nothing here may reach a real server
    // — nor a real desktop app (pass `env` with a LITERATI_CONNECTOR_URL to
    // test desktop pairing against a stub).
    env: { ...process.env, HOME: home, LITERATI_SERVER_URL: serverUrl, LITERATI_DESKTOP_PAIR: '0', ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit').then(([code]) => {
    throw new Error(`MCP server exited (code ${code}) before replying`);
  });
  exited.catch(() => {});
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const send = (method, params) => {
    const id = nextId++;
    const reply = new Promise((res) => waiting.set(id, res));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`no reply to ${method} within ${REPLY_TIMEOUT_MS}ms`)), REPLY_TIMEOUT_MS);
    });
    return Promise.race([reply, exited, timeout]).finally(() => clearTimeout(timer));
  };
  try {
    const init = (
      await send('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: clientName, version: '1.0.0' },
      })
    ).result;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const results = [];
    for (const [method, params] of requests) results.push((await send(method, params)).result);
    return { init, results };
  } finally {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
}

/**
 * A stand-in Literati server. `routes` maps "METHOD /path" to a JSON body, or
 * to a function `(body, res) => json` that may set `res.statusCode`. Every
 * request is recorded in `requests` with its headers. Unknown routes → 404.
 */
export async function stubServer(t, routes) {
  const requests = [];
  const srv = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const route = routes[`${req.method} ${req.url}`];
    res.setHeader('Content-Type', 'application/json');
    if (route === undefined) {
      res.statusCode = 404;
      return res.end('{}');
    }
    if (req.method === 'POST' && req.url === '/cli/pairing/requests') res.statusCode = 201;
    res.end(JSON.stringify(typeof route === 'function' ? route(body, res) : route));
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => {
    srv.closeAllConnections();
    srv.close();
  });
  return { url: `http://127.0.0.1:${srv.address().port}`, requests, srv };
}

export const toolNames = (r) => r.tools.map((t) => t.name);
export const callTool = (name, args = {}) => ['tools/call', { name, arguments: args }];
export const textOf = (r) => r.content.map((c) => c.text).join('\n');
