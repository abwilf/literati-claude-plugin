# Literati plugin for Claude Code

Gives Claude Code the ability to read and edit your Literati project, operating directly on
the project's server-side documents.

## Installation

**1.** Install: replace `your_project_id` below from your Literati project URL

```bash
claude plugin marketplace add abwilf/literati-claude-plugin && claude plugin install literati@literati && claude -p "/literati:login https://literati.ai/projects/your_project_id" --allowedTools "Bash"
```

**2.** Approve the pairing request on your project page, then run this with the one-time code it shows you:

```bash
claude "/literati:login YOUR_CODE_HERE"
```

## Un-installation

```bash
claude mcp remove --scope user literati   # first — else a stale entry points at a deleted bundle
claude plugin uninstall literati@literati && claude plugin marketplace remove literati
rm -rf ~/.literati                        # optional: credentials, bundle copy, session markers
```

## More

- See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for local development, the login walkthrough, MCP registration details, session syncing, and how to develop on the plugin.
- Every session that touches a Literati tool is synced back to Literati via deterministic hooks so you can `/resume` it later inside the Literati agent. Continuing a synced session in Literati forks it.
