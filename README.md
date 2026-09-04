# Literati plugin for Claude Code

Gives Claude Code the ability to read and edit your Literati project, operating directly on
the project's server-side documents.

## Installation

1. Install

```bash
claude plugin marketplace add abwilf/literati-claude-plugin && claude plugin install literati@literati
```

1. Open Claude Code and enter your project URL to pair (you'll only have to do this once at startup per repo)

```bash
claude
https://literati.ai/project/{your-project-here}/
```

1. Restart claude

```bash
exit
claude --continue
```

## Un-installation

```bash
claude mcp remove --scope user literati   # first — else a stale entry points at a deleted bundle
claude plugin uninstall literati@literati && claude plugin marketplace remove literati
rm -rf ~/.literati                        # optional: credentials, bundle copy, session markers
```

## More

- See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the login walkthrough, MCP registration details, session syncing, and how to develop on the plugin.
- Every session that touches a Literati tool is synced back to Literati via deterministic hooks so you can `/resume` it later inside the Literati agent. Continuing a synced session in Literati forks it.

