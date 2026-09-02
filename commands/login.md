---
description: Set up Literati in Claude Code — register the literati MCP server and pair this directory with a project
---

Set up Literati for this user: ensure the `literati` MCP server is registered at user scope, then pair this working directory with their Literati project. Project URL may have been provided as `$ARGUMENTS`.

## 1. Ensure the MCP server is registered

Run `claude mcp get literati` in Bash.

- If it shows a server whose command points at `~/.literati/mcp/bundle.mjs`, it is already registered — go to step 2.
- Otherwise:
  1. Check the bundle exists: `ls ~/.literati/mcp/bundle.mjs`. If missing (the SessionStart hook normally maintains it), copy it from the plugin: `mkdir -p ~/.literati/mcp && cp "${CLAUDE_PLUGIN_ROOT}/mcp/bundle.mjs" ~/.literati/mcp/bundle.mjs`
  2. Register it at user scope:
     `claude mcp add --scope user literati -- node ~/.literati/mcp/bundle.mjs`
     (For development against a non-default server, add `-e LITERATI_SERVER_URL=http://localhost:3000` after `literati` — `-e` is variadic, so placed before the name it swallows `literati` and the command fails.)
  3. Note for step 3: newly registered servers load on the next session.

## 2. Pair this directory with a project

Check pairing: `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" status`

If not paired:

- If the `mcp__literati__*` tools are already available in this session, prefer them: call `literati_login` with the project URL, then `literati_login_code` with the one-time code (they handle the same flow in-session).
- Otherwise use the pairing CLI:
  1. Ask the user for their Literati project URL (looks like `https://…/project/<id>`; a bare project id also works). Use `$ARGUMENTS` if provided.
  2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" start <project-url>` and relay its instructions: the user opens that project in the Literati web app, approves the "Claude Code pairing request" prompt, and is shown a one-time code.
  3. Ask for the code, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" code <one-time-code>`.

## 3. Finish

- Confirm which project the directory is now paired with.
- If the MCP server was newly registered in step 1, tell the user to restart Claude Code (or try `/mcp` → reconnect) so the `literati` tools load; everything is ready on the next session.
- If tools still don't appear after a restart, re-run `claude mcp get literati` to verify the registration.
