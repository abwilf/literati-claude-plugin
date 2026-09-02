# Literati plugin for Claude Code

Gives Claude Code the same tools as the Literati agent (read/edit/write files
in a Literati project, compile LaTeX, search & add papers, …), operating on
the project's server-side documents. Every session that touches a Literati
tool is synced back to Literati (deterministic hooks, full transcript), so you
can `/resume` it later inside the Literati agent. Continuing a synced session
in Literati forks it — changes never flow back to Claude Code.

The MCP server is registered at **user scope** under the name `literati`, so
tool calls display as `literati - edit (MCP)` (tools are namespaced
`mcp__literati__*`). The plugin itself ships the hooks (session context +
transcript sync), the `/literati:login` command, and the server bundle; it
does not declare the MCP server.

## Install

```bash
claude plugin marketplace add abwilf/literati-claude-plugin
claude plugin install literati@literati
```

Then open Claude Code and run `/literati:login` (your first session will greet
you and offer it). It registers the MCP server
(`claude mcp add --scope user literati -- node ~/.literati/mcp/bundle.mjs` —
the SessionStart hook keeps that bundle copy up to date) and pairs the current
directory with your project. Restart Claude Code once afterwards to load the
tools.

Point the MCP server at a non-default API host (dev default is
`http://localhost:3000`) by registering with an env var:

```bash
claude mcp add --scope user literati -e LITERATI_SERVER_URL=http://localhost:3000 -- node ~/.literati/mcp/bundle.mjs
```

## Log in

Run `/literati:login` (or just paste your project URL — it looks like
`http://localhost:3010/project/<id>` in dev):

1. Give Claude your project URL.
2. Open that project in the Literati web app; approve the "Claude Code
   pairing request" prompt.
3. Paste the one-time code back into Claude Code.

The pairing token is stored in `~/.literati/credentials.json` (chmod 600),
scoped to that one project and bound to the directory you paired from (and its
subdirectories). Revoke tokens anytime in Literati under Settings → CLI
tokens.

## Uninstall

```bash
claude mcp remove --scope user literati   # first — else a stale entry points at a deleted bundle
claude plugin uninstall literati@literati
claude plugin marketplace remove literati
rm -rf ~/.literati                        # optional: credentials, bundle copy, session markers
```

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
