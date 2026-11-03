---
description: Set up Literati in Claude Code — register the literati MCP server and pair this directory with a project
---

Set up Literati for this user: ensure the `literati` MCP server is registered at user scope, then pair this working directory with their Literati project. A project URL, or an 8-character pairing code from Literati's web pairing page, may optionally have been provided as `$ARGUMENTS`.

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

**Already paired is not a reason to stop** — with one exception: if step 1 just registered the MCP server for a folder that is already paired, that was the whole job; tell them to restart Claude Code and stop here — unless `$ARGUMENTS` has a code or a project URL, then pair with it as below (an explicit code must never be swallowed: it expires in 10 minutes). Otherwise, running this command on a paired folder means the user wants to pair again — to switch projects, or to refresh a revoked login. Tell them which project it is paired with now, then start pairing below exactly as for a fresh folder; the new pairing takes over for this folder. Never reply "it's already paired".

Start pairing **right away — do NOT ask for a project URL first.** Pairing happens in the Literati desktop app: the user picks the project in a Literati window and clicks Accept, and nothing needs pasting. Without the app (not installed, or it can't be started) the user pairs with a code from Literati's web pairing page instead — see "With a pairing code" below. Pass a project URL only if `$ARGUMENTS` already has one (it preselects that project).

**With a pairing code.** If `$ARGUMENTS` is an 8-character pairing code (letters and digits like `K7QM2XPT` — not a URL, not a 24-character project id), or the user gives you one later, they already created it on the web pairing page: skip the desktop app and exchange the code —
   - If the `mcp__literati__*` tools are available in this session, call `literati_login` with `code`.
   - Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" complete <code>`.
   Then read the result as in step 3 below. A failure message ends with a step addressed to you (`login.mjs complete <code>` / `literati_login`) — never show that part to the user. Each outcome has one bucket:
   - **"Doesn't look like a Literati pairing code"** (malformed — no request was sent) → relay it: it spells out the alphabet, and a 0 or 1 is usually an O or I. Ask the user to re-copy the code from the pairing page and exchange that. Never pass a code to `start`.
   - **"Not correct, or it expired or was already used"** → relay it; ask the user to check the code and exchange it again. Only if they say it expired or was already used do they create a new one on the pairing page.
   - **Rate limited / server error or unexpected reply / could not reach the server / too many CLI tokens** → tell the user what the message says: the wait it names (seconds, or "a few minutes"), or that an old token must be revoked (Settings → CLI & agent tokens). Exchange the SAME code again only once that time has passed or the user says so; if it fails again, stop and let the user decide. Never create a new code for these.
   - **"Does not support pairing codes"** → relay it as-is and stop. Do not start the desktop flow again — if the app were available you would not be exchanging a code. Mention the server URL the message names, in case `LITERATI_SERVER_URL` is wrong.
   - **"No longer exists"** (the project the code was for) → relay it; a new code only helps for a different project. On the desktop path the message is "The project you picked no longer exists": the user runs `/literati:login` again and picks another project.
   - **"Paired, but the credential could not be saved"** → relay it; the code is spent. The user fixes the problem (usually `~/.literati` permissions), then creates a new code.
   - **Anything else terminal** (two pastes at once, not unique, too many attempts) → ask the user for a new code from the pairing page.

1. **Before** starting, tell the user: "A Literati window will open — pick the project and click Accept." (The call blocks until they do, so you can't say it afterwards. Skip this when exchanging a code: nothing opens.)
2. Start pairing:
   - If the `mcp__literati__*` tools are available in this session, call
     `literati_login` (with `project_url` only if you have one).
   - Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs" start [project-url]`
     with a Bash **timeout of 300000 ms** — it can wait ~4 minutes (launching
     the app, then up to ~3 minutes for the user to accept), longer than the
     default Bash timeout.
3. Read the result:
   - **"Logged in to Literati project …"** → paired; go to section 3.
   - **"No Literati desktop app found"** (not installed, couldn't be started, or too old) → tell the user the two ways forward from the message, in their terms: open the pairing page URL it names in a browser where they are signed in to Literati, pick the project, type a machine name, copy the 8-character code and paste it here (or run `/literati:login <code>`); or install the app from https://literati.ai/download, open it, sign in and run `/literati:login` again. The message's `login.mjs complete` / `literati_login` step is addressed to you — never show it to the user. When they give you the code, exchange it as in "With a pairing code" above. Do not ask for a project URL.
   - **Declined / expired / didn't show the window / not signed in / a request already open** → relay the message as-is; they run `/literati:login` again when ready.
   - **Rate limited / server error / could not reach the server / too many CLI tokens** (the app approved, the server refused the exchange) → tell the user what the message says: the wait it names, or the token to revoke (Settings → CLI & agent tokens); run `/literati:login` again when that has passed or the user says so. Never ask for a project URL.
   - **"Paired, but the credential could not be saved"** → relay it; the user fixes the problem (usually `~/.literati` permissions), then runs `/literati:login` again.
   - **Server mismatch** (the desktop app is connected to a different server than this plugin talks to) → tell the user the two ways forward from the message, in their terms: it names both servers, which must match (`LITERATI_SERVER_URL` for the plugin) — fix that and run `/literati:login` again; or open the pairing page URL it names in a browser where they are signed in to Literati, pick the project, type a machine name, copy the 8-character code and paste it here (or run `/literati:login <code>`). The message's `login.mjs complete` / `literati_login` step is addressed to you — never show it to the user. When they give you the code, exchange it as in "With a pairing code" above. Do not ask for a project URL.

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
