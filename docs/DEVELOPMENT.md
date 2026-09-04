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

## Local development

To pair against a server running on your own machine, set `LITERATI_SERVER_URL`
**before pairing**:

```bash
LITERATI_SERVER_URL=http://localhost:3000 claude
```

…then run `/literati:login` in that session. The env var is inherited by the
stdio MCP server, so this needs no change to your registration.

If you prefer it permanent, re-register with the variable baked in — note `-e`
goes **after** the server name, since it is variadic and would otherwise
swallow `literati` ("Invalid environment variable format"):

```bash
claude mcp remove literati -s user
claude mcp add --scope user literati -e LITERATI_SERVER_URL=http://localhost:3000 -- node ~/.literati/mcp/bundle.mjs
```

**The host only matters at pairing time.** Once a directory is paired, its
server URL is stored per-directory in `~/.literati/credentials.json`, and that
stored value wins from then on. So:

- An already-paired directory keeps using the host it was paired against, with
  or without the env var.
- A dev-paired directory and a production-paired directory work side by side
  in the same Claude Code installation.
- To repoint an existing directory, pair it again with the env var set.

Check what a directory is bound to:

```bash
node -e "const j=require(require('os').homedir()+'/.literati/credentials.json');console.log(j.directories)"
```

Each entry maps a directory to a `<serverUrl>|<collectionId>` key. If a
directory you meant to pair against localhost shows `https://api.literati.ai|…`,
the env var did not reach the server — re-pair with it set.

## Log in

Run `/literati:login` (or just paste your project URL — it looks like
`https://literati.ai/projects/<id>`, or `http://localhost:3010/project/<id>`
in dev; a bare project id also works):

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
