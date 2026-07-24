# Literati plugin for Claude Code

Gives Claude Code the same tools as the Literati agent (read/edit/write files
in a Literati project, compile LaTeX, search & add papers, …), operating on
the project's server-side documents. Every session that touches a Literati
tool is synced back to Literati (deterministic hooks, full transcript), so you
can `/resume` it later inside the Literati agent. Continuing a synced session
in Literati forks it — changes never flow back to Claude Code.

## Install

```bash
claude plugin marketplace add abwilf/literati-claude-plugin
claude plugin install literati@literati
```

That's it — the MCP server ships inside the plugin as a self-contained bundle
(`mcp/bundle.mjs`, no npm install needed). Your first Claude Code session
after installing greets you and walks you through pairing with a project.

Point the MCP server at a non-default API host (dev default is
`http://localhost:3000`) with:

```bash
export LITERATI_SERVER_URL=http://localhost:3000
```

## Developing

The plugin's source of truth lives in the Literati monorepo under
`claude-plugin/`; the standalone repo is published from it via
`git subtree push --prefix=claude-plugin plugin-origin main`.

After editing the MCP server (`mcp/index.mjs` / `lib/`), rebuild the bundle
and bump the plugin version so installs pick it up:

```bash
cd mcp && npm install && npm run build       # regenerates mcp/bundle.mjs
# bump "version" in .claude-plugin/plugin.json, commit, subtree push, then:
claude plugin update literati@literati
```

## Log in

Run `/literati:login` (or just try any Literati tool — it will tell
you to log in):

1. Give Claude your project URL (`http://localhost:3010/project/<id>` in dev).
2. Open that project in the Literati web app; approve the "Claude Code
   pairing request" prompt.
3. Paste the one-time code back into Claude Code.

The pairing token is stored in `~/.literati/credentials.json` (chmod 600),
scoped to that one project. Revoke tokens anytime in Literati under
Settings → CLI tokens.

## How syncing works

- `PostToolUse` hook (on Literati MCP tools — both the `mcp__literati__*`
  sideload and `mcp__plugin_literati_literati__*` installed namespaces) marks the session and
  uploads the transcript; the `Stop` hook re-uploads at end of turn.
- Sessions that never use a Literati tool are never uploaded.
- Uploads are idempotent (keyed by Claude Code session id) and never block
  Claude Code on failure.

## Notes

- Long compiles: raise Claude Code's MCP timeout (`MCP_TIMEOUT`) if `compile`
  times out on large projects.
- Write tools (`edit`, `write`, `multi_edit`) are gated by Claude Code's own
  permission prompts; the Literati server executes paired calls directly.
