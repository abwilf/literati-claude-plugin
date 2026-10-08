// Pairing logic shared by the MCP server (literati_login / literati_login_code)
// and the pairing CLI (scripts/login.mjs). Plain Node (>=18), no dependencies.
//
// Two ways to obtain a pairing code:
//   - Desktop (preferred): the running Literati desktop app's local connector
//     shows a project picker; when the user accepts, it hands us the
//     requestId + code directly — nothing to paste.
//   - Code flow (fallback): POST /cli/pairing/requests for a given project,
//     the user approves in the web app and pastes the code back.
// Either way the code is exchanged with exchangePairingCode().
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { addProjectCredential } from './credentials.mjs';

// The desktop app's local connector. Overridable for tests.
export const CONNECTOR_URL = process.env.LITERATI_CONNECTOR_URL || 'http://127.0.0.1:21279';
// Required on every connector request (and no Origin header — Node's fetch
// sends none), so a web page can't drive the connector from a browser.
const CONNECTOR_HEADERS = { 'X-Literati-Connector': '1' };
const DEEP_LINK = 'literati://cli-pair';

export const normalizeServerUrl = (u) => String(u ?? '').replace(/\/+$/, '');

/**
 * Exchange a one-time code for a token and bind it to `cwd`.
 * `headers` are extra request headers (the caller's X-Literati-Client).
 * @returns {Promise<{ok:true, body:object} | {ok:false, reason:'network'|'invalid_code'|'terminal', message:string}>}
 *   'invalid_code' is retryable (the request is still alive); 'terminal' means
 *   the request is dead server-side.
 */
export async function exchangePairingCode({ serverUrl, requestId, code, cwd, headers = {} }) {
  let res;
  try {
    res = await fetch(`${serverUrl}/cli/pairing/requests/${requestId}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, reason: 'network', message: `Could not reach the Literati server: ${err.message}` };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body?.code === 'PAIRING_INVALID_CODE') {
      return { ok: false, reason: 'invalid_code', message: 'That code is not correct.' };
    }
    return {
      ok: false,
      reason: 'terminal',
      message: 'Pairing could not be completed (expired, denied, or too many attempts).',
    };
  }
  const body = await res.json();
  addProjectCredential(
    {
      serverUrl,
      token: body.token,
      collectionId: body.collectionId,
      workspaceId: body.workspaceId,
      userId: body.userId,
      projectSlug: body.projectSlug,
      projectName: body.projectName,
    },
    cwd,
  );
  return { ok: true, body };
}

/** A timeout that also follows `outer` (AbortSignal.any is Node 20+; we target 18). */
function requestSignal(outer, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!outer) return timeout;
  const c = new AbortController();
  const follow = (s) => () => c.abort(s.reason);
  if (outer.aborted) c.abort(outer.reason);
  outer.addEventListener('abort', follow(outer), { once: true });
  timeout.addEventListener('abort', follow(timeout), { once: true });
  return c.signal;
}

async function connector(connectorUrl, path, { method = 'GET', body, timeoutMs, signal, client }) {
  const headers = { ...CONNECTOR_HEADERS, ...(client ? { 'X-Literati-Client': client } : {}) };
  return fetch(`${connectorUrl}${path}`, {
    method,
    headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: requestSignal(signal, timeoutMs),
  });
}

/** Best-effort: withdraw a pending request so the app closes its picker. */
function cancelPair(connectorUrl, pairId, client) {
  return connector(connectorUrl, `/cli-pair/${encodeURIComponent(pairId)}`, {
    method: 'DELETE',
    timeoutMs: 2000,
    client,
  }).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn(signal)` with a signal that aborts on SIGINT/SIGTERM (and when
 * `outer` aborts), so an in-flight desktopPair() can withdraw its request
 * before the process dies. Exits with the conventional code once `fn` has
 * settled if a process signal arrived. (A plain `process.exit` can't be
 * covered: 'exit' handlers can't do async work.)
 */
export async function withCancellation(fn, outer) {
  const c = new AbortController();
  let caught = null;
  const onSignal = (sig) => {
    caught = sig;
    c.abort();
  };
  const onOuter = () => c.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  if (outer?.aborted) c.abort();
  outer?.addEventListener('abort', onOuter, { once: true });
  try {
    return await fn(c.signal);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    outer?.removeEventListener('abort', onOuter);
    if (caught) process.exit(caught === 'SIGINT' ? 130 : 143);
  }
}

/** @returns {Promise<{reachable:false} | {reachable:true, hello:object|null}>}
 *  hello is null when something answered but it isn't a desktop app that
 *  supports CLI pairing (e.g. an older app version → 404). */
async function probe(connectorUrl, client) {
  let res;
  try {
    res = await connector(connectorUrl, '/cli-pair/hello', { timeoutMs: 1000, client });
  } catch {
    return { reachable: false };
  }
  const hello = res.ok ? await res.json().catch(() => null) : null;
  return { reachable: true, hello: hello?.app === 'literati' ? hello : null };
}

/** Launch/focus the desktop app via its deep link. Resolves false if the
 * opener failed (e.g. no app registered for literati://). */
export function launchDesktopApp() {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [DEEP_LINK]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', DEEP_LINK]] // '' = window title; Node quotes it as ""
        : ['xdg-open', [DEEP_LINK]];
  return new Promise((done) => {
    try {
      execFile(cmd, args, { timeout: 10_000 }, (err) => done(!err));
    } catch {
      done(false);
    }
  });
}

/**
 * Pair via the Literati desktop app. Blocks until the user accepts/denies in
 * the app, the app expires the request, `signal` aborts, or our deadline
 * passes. The deadline sits just past the app's own 3-minute TTL so that the
 * app's `expired` normally ends the wait; ours only fires if the app stops
 * answering, and then (like an abort) withdraws the request with a DELETE.
 *
 * `client` ('codex' | 'claude-code', or null when unknown) tells the app which
 * agent is asking, for its picker's wording; also sent as X-Literati-Client.
 *
 * @returns {Promise<
 *   | {kind:'unavailable'}                         // no desktop app (or it doesn't support CLI pairing)
 *   | {kind:'server_mismatch', appServerUrl:string}
 *   | {kind:'signed_out'} | {kind:'busy'}
 *   | {kind:'approved', requestId:string, code:string, projectName?:string, projectSlug?:string}
 *   | {kind:'denied'} | {kind:'expired'} | {kind:'not_shown'} | {kind:'timeout'} | {kind:'cancelled'}
 *   | {kind:'error', message:string}>}
 */
export async function desktopPair({
  serverUrl,
  cwd,
  requesterLabel,
  project,
  client,
  connectorUrl = CONNECTOR_URL,
  launch = launchDesktopApp,
  launchWaitMs = 30_000,
  probeIntervalMs = 1000,
  pollDeadlineMs = 3 * 60_000 + 15_000,
  signal,
}) {
  if (process.env.LITERATI_DESKTOP_PAIR === '0') return { kind: 'unavailable' };

  let p = await probe(connectorUrl, client);
  if (!p.reachable && (await launch())) {
    const until = Date.now() + launchWaitMs;
    while (!p.reachable && Date.now() < until && !signal?.aborted) {
      await sleep(probeIntervalMs);
      p = await probe(connectorUrl, client);
    }
  }
  if (!p.reachable || !p.hello) return { kind: 'unavailable' };
  if (normalizeServerUrl(p.hello.serverUrl) !== normalizeServerUrl(serverUrl)) {
    return { kind: 'server_mismatch', appServerUrl: normalizeServerUrl(p.hello.serverUrl) };
  }
  if (!p.hello.signedIn) return { kind: 'signed_out' };
  if (signal?.aborted) return { kind: 'cancelled' };

  let res;
  try {
    res = await connector(connectorUrl, '/cli-pair', {
      method: 'POST',
      body: {
        cwd: resolve(cwd),
        requesterLabel,
        ...(project ? { project } : {}),
        ...(client ? { client } : {}),
      },
      timeoutMs: 10_000,
      client,
    });
  } catch (err) {
    return { kind: 'error', message: `Could not reach the Literati desktop app: ${err.message}` };
  }
  if (res.status === 401) return { kind: 'signed_out' };
  if (res.status === 409) return { kind: 'busy' };
  if (!res.ok) return { kind: 'error', message: `The Literati desktop app refused the pairing request (HTTP ${res.status}).` };
  const { pairId } = await res.json().catch(() => ({}));
  if (!pairId) return { kind: 'error', message: 'The Literati desktop app returned an unexpected response.' };

  // The connector long-polls each GET ~25s and expires a request that goes
  // ~40s without a poll, so re-poll as soon as each one returns.
  const deadline = Date.now() + pollDeadlineMs;
  while (Date.now() < deadline) {
    const polledAt = Date.now();
    try {
      res = await connector(connectorUrl, `/cli-pair/${encodeURIComponent(pairId)}`, {
        timeoutMs: Math.min(30_000, Math.max(1000, deadline - Date.now())),
        signal,
        client,
      });
    } catch (err) {
      if (signal?.aborted) {
        await cancelPair(connectorUrl, pairId, client);
        return { kind: 'cancelled' };
      }
      if (err?.name === 'TimeoutError') continue; // our own per-poll cap; the deadline check ends the loop
      return { kind: 'error', message: `Lost contact with the Literati desktop app: ${err.message}` };
    }
    if (res.status === 404) return { kind: 'expired' }; // e.g. the app restarted and forgot the request
    if (!res.ok) return { kind: 'error', message: `The Literati desktop app returned HTTP ${res.status}.` };
    const body = await res.json().catch(() => ({}));
    if (body.status === 'pending') {
      // A connector that answers instantly instead of long-polling must not
      // turn this into a busy loop; ~1s between polls is still well inside 25s.
      const elapsed = Date.now() - polledAt;
      if (elapsed < 1000) await sleep(Math.min(1000 - elapsed, Math.max(0, deadline - Date.now())));
      if (signal?.aborted) {
        await cancelPair(connectorUrl, pairId, client);
        return { kind: 'cancelled' };
      }
      continue;
    }
    if (body.status === 'approved' && body.requestId && body.code) {
      return {
        kind: 'approved',
        requestId: body.requestId,
        code: body.code,
        projectName: body.projectName,
        projectSlug: body.projectSlug,
      };
    }
    if (body.status === 'denied') return { kind: 'denied' };
    if (body.status === 'expired') return { kind: body.reason === 'not_shown' ? 'not_shown' : 'expired' };
    return { kind: 'error', message: 'The Literati desktop app returned an unexpected response.' };
  }
  await cancelPair(connectorUrl, pairId, client);
  return { kind: 'timeout' };
}

/** User-facing text for the desktop outcomes that end the login attempt
 * (everything except 'approved', 'unavailable' and 'server_mismatch').
 * `retry` names how to start over, e.g. "call literati_login again". */
export function desktopOutcomeMessage(outcome, retry) {
  switch (outcome.kind) {
    case 'signed_out':
      return `The Literati desktop app is open but not signed in. Ask the user to sign in there, then ${retry}.`;
    case 'busy':
      return `The Literati desktop app already has a pairing request open. Ask the user to finish or dismiss it there, then ${retry}.`;
    case 'denied':
      return 'The user declined the pairing request in the Literati desktop app. Nothing was paired.';
    case 'expired':
      return `The pairing request in the Literati desktop app expired before it was accepted. To try again, ${retry}.`;
    case 'not_shown':
      return "Literati couldn't show the pairing window — open the Literati app, make sure you're signed in, then try again.";
    case 'timeout':
      return `The Literati desktop app stopped responding to the pairing request. When the user is ready, ${retry}.`;
    case 'cancelled':
      return 'Pairing was cancelled; the request in the Literati desktop app was withdrawn.';
    default:
      return outcome.message ?? 'Pairing via the Literati desktop app failed.';
  }
}

/** Note prefixed to the code-flow output when the desktop app couldn't be used. */
export function desktopFallbackNote(outcome, serverUrl) {
  if (outcome.kind === 'server_mismatch') {
    return `Note: the Literati desktop app is connected to ${outcome.appServerUrl}, but this plugin pairs against ${normalizeServerUrl(serverUrl)}, so the app can't be used here — falling back to a pairing code.`;
  }
  return '';
}
