# Literati plugin — development & details

Everything beyond the quick install in the [top-level README](../README.md):
how the plugin is wired, how to log in step by step, how to work on it, and
how session syncing behaves.

## How the plugin is wired

The MCP server is registered at **user scope** under the name `literati`, so
tool calls display as `literati - edit (MCP)` (tools are namespaced
`mcp__literati__*`). The plugin itself ships the hooks (session context +
transcript sync), the `/literati:login` command, and the server bundle; it
does not declare the MCP server.

### Pointing at a dev server

The default API host is `https://api.literati.ai` (`mcp/index.mjs`,
`scripts/login.mjs`). To work against a local server, register with
`LITERATI_SERVER_URL` — note `-e` goes **after** the server name, since it is
variadic and would otherwise swallow `literati`:

```bash
claude mcp add --scope user literati -e LITERATI_SERVER_URL=http://localhost:3000 -- node ~/.literati/mcp/bundle.mjs
```

**This matters at pairing time.** Pairing requests go to the default host
(`LITERATI_SERVER_URL` or production), while tool calls for an already-paired
directory go to the `serverUrl` stored in that credential. So a registration
without the env var pairs against production even if you previously had a
`localhost:3000` credential on disk. Set the env var *before* running
`/literati:login`, or the login silently targets the wrong server. The same
applies to the pairing CLI directly:

```bash
LITERATI_SERVER_URL=http://localhost:3000 node scripts/login.mjs start <project-url>
```

## Log in

Run `/literati:login` (or just paste your project URL — `https://…/project/<id>`,
or `http://localhost:3010/project/<id>` against a dev web app; a bare project
id also works):

1. Give Claude your project URL.
2. Open that project in the Literati web app; approve the "Claude Code
   pairing request" prompt.
3. Paste the one-time code back into Claude Code.

The pairing token is stored in `~/.literati/credentials.json` (chmod 600),
scoped to that one project and bound to the directory you paired from (and its
subdirectories). Revoke tokens anytime in Literati under Settings → CLI
tokens.

## Developing

This repo is the source of truth (the plugin previously lived in the Literati
monorepo under `claude-plugin/`; server-side code — routes, tool execution —
still does).

After editing the MCP server (`mcp/index.mjs` / `lib/`), rebuild the bundle
and bump the plugin version so installs pick it up:

```bash
cd mcp && npm install && npm run build       # regenerates mcp/bundle.mjs
# bump "version" in .claude-plugin/plugin.json, commit, push, then:
claude plugin update literati@literati
```

The version bump matters twice: it ships the new plugin AND triggers the
SessionStart hook to refresh the stable bundle copy at
`~/.literati/mcp/bundle.mjs` (compared via `~/.literati/mcp/manifest.json`).

For development, you can point the registration at your checkout directly:

```bash
claude mcp add --scope user literati -e LITERATI_SERVER_URL=http://localhost:3000 -- node <your-checkout>/mcp/bundle.mjs
```

See [TESTING.md](../TESTING.md) for the manual test passes.

## How syncing works

- `PostToolUse` hook (matcher covers the current `mcp__literati__*` namespace
  plus the legacy ≤0.5.2 plugin-declared namespaces) marks the session and
  uploads the transcript; the `Stop` hook re-uploads at end of turn.
- Sessions that never use a Literati tool are never uploaded.
- Uploads are idempotent (keyed by Claude Code session id) and never block
  Claude Code on failure.

## Notes

- Long compiles: raise Claude Code's MCP timeout (`MCP_TIMEOUT`) if `compile`
  times out on large projects.
- Write tools (`edit`, `write`, `multi_edit`) are gated by Claude Code's own
  permission prompts; the Literati server executes paired calls directly.
- Upgrading from ≤0.5.2 (plugin-declared server): the first session after
  updating nudges you to run `/literati:login` once — it registers the
  user-scope server; your existing pairing is kept.
