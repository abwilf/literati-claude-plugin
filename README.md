# Literati plugin for Claude Code

Gives Claude Code the ability to read and edit your Literati project, operating directly on
the project's server-side documents.

## Installation

Pairing goes through the [Literati desktop app](https://literati.ai/download): have it installed and signed in, then from your project folder:

```bash
claude plugin marketplace add abwilf/literati-claude-plugin && claude plugin install literati@literati
```

Then open Claude Code in your project folder and type `/literati:login`. Approve the two commands it runs; the Literati desktop app opens a project picker — pick the project and click Accept.

A Literati window opens — pick the project and click Accept. No project id needed; the folder (and its subfolders) is paired with that project. In Codex, install the same plugin (`codex plugin marketplace add abwilf/literati-claude-plugin && codex plugin add literati@literati`) and ask it to call `literati_login` from the project folder.

## Un-installation

```bash
claude mcp remove --scope user literati   # first — else a stale entry points at a deleted bundle
claude plugin uninstall literati@literati && claude plugin marketplace remove literati
rm -rf ~/.literati                        # optional: credentials, bundle copy, session markers
```

## More

- See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for local development, the login walkthrough, MCP registration details, session syncing, and how to develop on the plugin.
- Every session that touches a Literati tool is synced back to Literati via deterministic hooks so you can `/resume` it later inside the Literati agent. Continuing a synced session in Literati forks it.
