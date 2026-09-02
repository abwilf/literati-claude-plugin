# Literati × Claude Code — end-to-end test walkthrough

A realistic tour of every feature, in the order a new user would hit them.
Prereqs: dev stack running (`/dev` — server :3000, web :3010, compilers
:4100/:4101, Docker), browser logged into `localhost:3010`.

---

## 0. Reset to a brand-new user

```bash
claude mcp remove --scope user literati 2>/dev/null   # user-scope server registration
claude plugin uninstall literati 2>/dev/null
claude plugin marketplace remove literati 2>/dev/null
mv ~/.literati/credentials.json ~/.literati/credentials.json.bak 2>/dev/null
rm -f ~/.literati/welcomed
rm -rf ~/.literati/sessions ~/.literati/mcp
```

Hard-refresh the browser tab on your project page (new renderer code:
pairing modal, bib-approval modal, compile bridge).

## 1. Install (the real distribution path)

```bash
claude plugin marketplace add abwilf/literati-claude-plugin
claude plugin install literati@literati
```

**Expect:** `claude plugin list` shows literati. The MCP server is NOT yet
registered (`claude mcp get literati` fails) — that happens in the login flow
below. The first session's SessionStart hook creates
`~/.literati/mcp/bundle.mjs` + `manifest.json` (verify after step 2 starts).

## 2. First-run welcome + login

```bash
export LITERATI_SERVER_URL=http://localhost:3000   # dev only
cd ~/some-scratch-dir && claude
```

Say anything ("hi").

**Expect:** Claude opens with a welcome — you just installed Literati, brief
overview (edit/compile LaTeX, papers, session sync), pointing at
`/literati:login`. This welcome happens exactly ONCE per machine
(`~/.literati/welcomed` marker); later unpaired sessions just offer login
when relevant.

Run `/literati:login` (or paste your project URL,
`http://localhost:3010/project/<id>`):
1. **Expect:** Claude registers the MCP server via Bash (you approve the
   `claude mcp add --scope user literati -- node ~/.literati/mcp/bundle.mjs`
   command; for dev it should include `-e LITERATI_SERVER_URL=…` after
   `literati`), then
   starts pairing via `scripts/login.mjs`.
2. **Expect:** a "Claude Code pairing request" modal pops on the project page
   in the browser within ~1s. Approve → 8-char code appears.
3. Paste the code into Claude Code → "Logged in to <project>", and Claude
   tells you to restart Claude Code to load the tools.
4. Restart. **Expect:** `/mcp` shows a server named `literati` (NO
   `plugin:` prefix); ~19 tools namespaced `mcp__literati__*`; a tool call
   renders as `literati - list_files (MCP)`. Also try Deny on a second login
   to see the denial path.

**Per-directory scoping:** `cd` to a different directory, run `claude`, ask
about the project — **expect** logged-out + login offer (credentials bind to
the directory tree you paired from; no global fallback).

## 3. Session context + instructions

In a paired directory, fresh session:
- Ask "which Literati project am I on and what files does it have?" —
  **expect** answer from session context without tool calls.
- Ask "what are the Literati editing conventions?" — **expect** it recites
  the MCP instructions (read-before-edit, line-numbered reads, never
  hand-edit .bib, compile-after-edit, stage/commit only-on-request).

## 4. Core editing loop

- "Read main.tex" → **expect** `cat -n` numbered output; "read lines 40–60 of
  main.tex" exercises offset/limit.
- "Grep for \\cite commands" → `path:line:` matches.
- Ask for a small wording edit → Claude Code's own permission prompt → edit
  lands **live in the browser editor** (Yjs).
- Ask for several related edits in one file → should use `multi_edit` (a
  real array of edits).
- "Create a file scratch.tex with ..." → **expect the file tree in the
  browser updates immediately** (origin-less tree event).
- "Rename scratch.tex to notes/scratch.tex" / "delete scratch.tex" →
  approval prompts in Claude Code; **browser file explorer refreshes each
  time without a manual reload**.

## 5. Compile + viewer broadcast

Ask it to compile.
**Expect:** result in Claude Code AND the browser's PDF/error panel
refreshes on its own (`compile:finished` event — no SSE stream exists for
MCP compiles). Break the LaTeX on purpose and ask again — Claude should read
errors, fix, and re-compile per the instructions.

## 6. The .bib hard gate

Say: "add this BibTeX entry to custom.bib: @misc{test2026, title={Test}}".
**Expect (in order):**
1. Claude should FIRST push back and propose `add_paper` (instructions).
2. If you insist, the edit call blocks and a **bib-approval modal** appears
   in the browser: Approve → the edit executes (exactly once); Deny →
   Claude reports the denial and does NOT retry; ignore for ~4 min →
   distinct timeout message suggesting add_paper or opening the web app.
3. `add_paper` with an arXiv id/URL should work without any gate.

## 7. Papers

- "What papers are in this project?" → `list_papers`.
- "Skim <paper>" → abstract + notes text.
- "Read <paper>'s PDF and tell me what datasets they use" → **expect**
  `get_paper_pdf` (presigned URL) + a **subagent** (Task) downloads and
  reads the PDF — the main conversation stays lean; only findings return.
- A general web question → **expect native WebSearch**, never a Literati
  tool (web_search is excluded from MCP).

## 8. Version control (explicit-ask only)

- Make some edits, then ask something unrelated — **expect NO staging or
  committing on its own.**
- "Stage my changes" → `stage_changes {all: true}` (approval prompt) →
  staged set visible in the web app's VC panel (`staging:changed` event).
- "Commit with message X" → `commit_changes` → commit appears in the
  browser's history panel live.
- "Commit" with nothing staged → helpful "stage first" message.

## 9. Transcript sync + resume + fork

After a session that used Literati tools:
1. `ls ~/.literati/sessions/` → marker file for the session (only sessions
   that touched Literati tools sync — verify a no-Literati session leaves no
   marker and never uploads).
2. In the web app agent panel: `/resume` → the session appears with a
   **"Claude Code" badge**, tool calls rendered with proper cards (names
   normalized: `edit`, `compile`, plus raw `Bash` etc. for native tools).
3. Open it and send a message → **expect a forked conversation** (badged
   original untouched).
4. Continue in Claude Code, then `/resume` again → original updated with new
   turns; your fork unaffected.

## 10. Revocation + recovery

- Web app → Settings → CLI tokens: revoke the token.
- Next Literati tool call in Claude Code → "login expired — re-pair" →
  running the login flow again recovers.
- Restore your dev credential when done:
  `mv ~/.literati/credentials.json.bak ~/.literati/credentials.json`

---

## Troubleshooting

| Symptom | Check |
|---|---|
| No pairing modal | Browser tab must be OPEN on that project's page (prompt rides the project WebSocket); hard-refresh after server restarts |
| No welcome | `rm ~/.literati/welcomed` and start a new session |
| Tools missing | `/mcp` — is `literati` connected? `claude mcp get literati` registered and pointing at `~/.literati/mcp/bundle.mjs`? Registered with `-e LITERATI_SERVER_URL` for dev? |
| No /resume entry | `ls ~/.literati/sessions/` — no marker means no Literati tool ran (PostToolUse matcher) |
| Compile/tree not refreshing in browser | Hard-refresh the tab (new bundle needed after renderer changes) |
| Plugin edits not taking effect | Bump version in `.claude-plugin/plugin.json`, rebuild `mcp/bundle.mjs`, `claude plugin update literati@literati`, restart session (the SessionStart hook refreshes `~/.literati/mcp/bundle.mjs` on version change) |
| Two tool sets (duplicated tools) | A legacy sideload (`--plugin-dir`) or ≤0.5.2 plugin-declared server is active alongside the user-scope one — remove the sideload / update the plugin |
