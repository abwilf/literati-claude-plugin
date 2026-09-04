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
  6. **Always end with the command that delivers the code.** You usually cannot
     tell whether this session can receive a reply (a `claude -p ...` run ends
     with your message and has no prompt to type into), so never leave them
     with only "paste it here". Close with a numbered step worded like:

         3. Paste the code into Claude:

            claude "/literati:login YOUR_CODE_HERE"

     Show that command as a plain indented line — do NOT wrap it in a fenced
     ```bash block. Mention the directory only if it differs from where they
     are now. And do NOT suggest `claude -c`, which does not resume a `-p`
     session — re-invoking this command is what carries the state, since the
     pending request lives on disk.

## 3. Finish — welcome them to the project

Once the pairing succeeds, don't just report success — open the project for
them. Lead with the project name and a party emoji:

> **Welcome to your Literati project "<project name>"! 🎉**

Then, **if the Literati tools are loaded in this session** — they are whenever
the pairing completed through `literati_login_code` — call `list_files` and show
what's in the project. Keep it readable: a short list, or a summary by kind if
there are many files.

Then a brief "here's what I can do", in the user's terms rather than tool names.
Something like:

> - **Write and edit** — read and edit the `.tex`, `.bib` and `.sty` files directly on the server, so every change shows up live for you and your collaborators
> - **Compile** — build the PDF and work through any LaTeX errors until it's clean
> - **Find papers** — search for relevant work and add it straight to your library and bibliography
> - **Use your library** — list what you've collected, skim papers, pull out claims and citations
> - **Checkpoint** — stage and commit when you want to save a milestone

Close by asking what they're working on.

Keep the whole thing tight: a greeting, the files, about five capability lines.
Do not dump the raw tool list or enumerate every tool name.

- If the MCP server was newly registered in step 1, the tools are NOT loaded in
  this session. Still give the welcome and the capability summary, but skip the
  file list, tell the user to restart Claude Code (or try `/mcp` → reconnect),
  and offer to show them the project files as soon as it comes back.
- If tools still don't appear after a restart, re-run `claude mcp get literati`
  to verify the registration.
