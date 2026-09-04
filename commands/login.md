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
     (Defaults to `https://api.literati.ai`. For local development add `-e LITERATI_SERVER_URL=http://localhost:3000` AFTER `literati` — `-e` is variadic, so placed before the name it swallows `literati` and the command fails with "Invalid environment variable format". Alternatively launch as `LITERATI_SERVER_URL=http://localhost:3000 claude` and the stdio server inherits it. The host is only used when a directory is FIRST paired; afterwards it comes from `~/.literati/credentials.json`.)
  3. Note for step 3: newly registered servers load on the next session.

## 2. Pair this directory with a project

**First: is `$ARGUMENTS` a one-time pairing code rather than a project URL?**
(No `://`, not a URL — typically a short alphanumeric code.) Then the user is
FINISHING a pairing that was started in an earlier session, and the in-flight
request is on disk. Complete it directly and skip the rest of this section:

- Prefer the MCP tool if loaded: call `literati_login_code` with the code. This
  is the path that makes the project tools appear in THIS session without a
  restart.
- Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" code <code>`.

Do NOT assume you remember starting the pairing — you will usually be a fresh
session with no memory of it, and that is fine: the pending request is read from
`~/.literati/pairing-pending.json`, not from conversation history. Only if that
reports "no pairing in progress" should you fall back to asking for a project
URL and starting over.

Check pairing: `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" status`

If not paired:

- If the `mcp__literati__*` tools are already available in this session, prefer them: call `literati_login` with the project URL, then `literati_login_code` with the one-time code (they handle the same flow in-session). After `literati_login` returns, open the project page for them the same way (`open "<project-url>"` on macOS, `xdg-open` on Linux, `start ""` on Windows).
- Otherwise use the pairing CLI:
  1. Ask the user for their Literati project URL (looks like `https://literati.ai/projects/<id>`; a bare project id also works). Use `$ARGUMENTS` if provided.
  2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" start <project-url>`.
  3. **Then** open the project page in their browser so they don't have to click anything — only after the start command succeeded, since the approval prompt only appears once the request exists. Use the platform's opener with the URL quoted (`open` on macOS, `xdg-open` on Linux, `start ""` on Windows), e.g. `open "<project-url>"`. Skip this if they gave a bare project id rather than a URL, or if the opener fails — it is a convenience, never a reason to stop.
  4. Relay the instructions either way: they approve the "Claude Code pairing request" prompt on that page and are shown a one-time code.
  5. Ask for the code, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" code <one-time-code>`.
  6. **If you cannot receive the code in this session** — you are a one-shot
     non-interactive run (`claude -p ...`), so the session ends with your reply
     and there is no prompt for them to type into — do NOT ask them to paste it
     here. End your message with the exact command to run instead, on its own
     line and with the placeholder obvious:

     ```bash
     claude "/literati:login your_code_here"
     ```

     Tell them plainly: approve the request in the browser, copy the one-time
     code, and run that command with the code in place of `your_code_here`,
     from this same directory. Do NOT tell them to use `claude -c`: a `-p`
     session is not resumed by `--continue`, so the next session would have no
     idea a pairing was in flight. Re-invoking this command is what carries the
     state, because the pending request lives on disk.

## 3. Finish

- Confirm which project the directory is now paired with.
- If the MCP server was newly registered in step 1, tell the user to restart Claude Code (or try `/mcp` → reconnect) so the `literati` tools load; everything is ready on the next session. If instead the pairing was finished in a later session via `literati_login_code`, the tools load into that session immediately — no restart to mention.
- If tools still don't appear after a restart, re-run `claude mcp get literati` to verify the registration.
