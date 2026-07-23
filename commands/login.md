---
description: Log in to a Literati project so Literati tools work in this session
---

Walk the user through pairing Claude Code with their Literati project:

1. Ask the user for their Literati project URL (it looks like `https://…/project/<id>`; a bare project id also works). If they provided it as `$ARGUMENTS`, use that.
2. Call the `literati_login` tool with the project URL. Relay its instructions: the user must open that project in the Literati web app and approve the "Claude Code pairing request" prompt, which shows them a one-time code.
3. Ask the user for the one-time code, then call `literati_login_code` with it.
4. Confirm which project they are now paired with. If the Literati tools (edit, compile, list_papers, …) do not appear, tell the user to reconnect MCP servers or restart Claude Code.
