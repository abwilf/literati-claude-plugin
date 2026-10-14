---
description: Set up Literati in Claude Code — register the literati MCP server and pair this directory with a project
---

Set up Literati for this user: ensure the `literati` MCP server is registered at user scope, then pair this working directory with their Literati project. A project URL may optionally have been provided as `$ARGUMENTS`.

## 1. Ensure the MCP server is registered

Run `claude mcp get literati` in Bash.

- If it shows a server whose command points at `~/.literati/mcp/bundle.mjs`, it is already registered — go to step 2.
- Otherwise:
  1. Check the bundle exists: `ls ~/.literati/mcp/bundle.mjs`. If missing (the SessionStart hook normally maintains it), copy it from the plugin: `mkdir -p ~/.literati/mcp && cp "${CLAUDE_PLUGIN_ROOT}/mcp/bundle.mjs" ~/.literati/mcp/bundle.mjs`
  2. Register it at user scope:
     `claude mcp add --scope user literati -- node ~/.literati/mcp/bundle.mjs`
     (Defaults to `https://api.literati.ai`. For local development add `-e LITERATI_SERVER_URL=http://localhost:3000` AFTER `literati` — `-e` is variadic, so placed before the name it swallows `literati` and the command fails with "Invalid environment variable format". Alternatively launch as `LITERATI_SERVER_URL=http://localhost:3000 claude` and the stdio server inherits it. The host is used whenever a directory is paired or re-paired; between pairings the folder's server comes from `~/.literati/credentials.json`.)
  3. Note for step 3: newly registered servers load on the next session.

## 2. Pair this directory with a project

Check pairing: `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" status`

**Already paired is not a reason to stop** — with one exception: if step 1 just registered the MCP server for a folder that is already paired, that was the whole job; tell them to restart Claude Code and stop here. Otherwise, running this command on a paired folder means the user wants to pair again — to switch projects, or to refresh a revoked login. Tell them which project it is paired with now, then start pairing below exactly as for a fresh folder; the new pairing takes over for this folder. Never reply "it's already paired".

Start pairing **right away — do NOT ask for a project URL first.** Pairing happens in the Literati desktop app: the user picks the project in a Literati window and clicks Accept, and nothing needs pasting. Without the app (not installed, or it can't be started) pairing is refused — there is no other way to pair. Pass a project URL only if `$ARGUMENTS` already has one (it preselects that project).

1. **Before** starting, tell the user: "A Literati window will open — pick the project and click Accept." (The call blocks until they do, so you can't say it afterwards.)
2. Start pairing:
   - If the `mcp__literati__*` tools are available in this session, call
     `literati_login` (with `project_url` only if you have one).
   - Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" start [project-url]`
     with a Bash **timeout of 300000 ms** — it can wait ~4 minutes (launching
     the app, then up to ~3 minutes for the user to accept), longer than the
     default Bash timeout.
3. Read the result:
   - **"Logged in to Literati project …"** → paired; go to section 3.
   - **Desktop app isn't installed, couldn't be started, or is too old** → relay the message as-is: it points them at https://literati.ai/download; they install it, open it, sign in, then run `/literati:login` again. Do not ask for a project URL; there is no other way to pair.
   - **Declined / expired / didn't show the window / not signed in / a request already open** → relay the message as-is; they run `/literati:login` again when ready.
   - **Server mismatch** (the desktop app is connected to a different server than this plugin talks to) → relay the message as-is: it names both servers and says they must match (`LITERATI_SERVER_URL` for the plugin). Do not ask for a project URL.

## 3. Finish — welcome them to the project

**Precondition: the pairing has actually COMPLETED** — the result said "Logged in to Literati project …" and the credential is written. Never run any of this after a refusal, or while the pairing call is still waiting for the user to accept in the app.

Once the pairing succeeds, don't just report success — open the project for
them. Lead with the project name and a party emoji:

> **Welcome to your Literati project "<project name>"! 🎉**

Then, **if the Literati tools are loaded in this session** — they are whenever
the pairing completed through `literati_login` — call `list_files` and show
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

- If the pairing completed but the MCP server was only registered moments ago,
  its tools are not loaded in this session: give the welcome and the capability
  summary, skip the file list, tell the user to restart Claude Code (or try
  `/mcp` → reconnect), and offer to show the project files once it is back.
- If tools still don't appear after a restart, re-run `claude mcp get literati`
  to verify the registration.
