# Guarding new dependencies

Coding agents add packages all the time. Some of those packages do not exist (an assistant invented
the name, and an attacker may have registered it), imitate a popular package, are known malware, or
shipped an hour ago. `guard` judges a package **before** it is installed and tells you, or your
agent, whether to go ahead.

```bash
autoremediator guard lodash express@4 @scope/pkg
```

```text
BLOCK lodahs (0.0.1-security)
  warn  typosquat: "lodahs" looks like "lodash". Check that you meant it.
  block malware: lodahs@0.0.1-security is listed as malicious in the OSV malware feed (MAL-2025-25502).
  instead: lodash (the widely used package with a similar name)
```

It reads the npm registry (from your `.npmrc`) and OSV, and installs nothing.

## What it checks

| Check | Result |
| ----- | ------ |
| The package and version exist | **block** if not, with the popular name it was probably meant to be |
| Known malware (OSV `MAL-` records) | **block** |
| Name next to a widely used package (a built-in list of about 180) | **warn**; **block** if the package was first published under 30 days ago |
| Release age (default 72 hours, `--min-age-hours`, `0` turns it off) | **block**, and the newest old-enough version is offered |
| Install scripts (`preinstall`, `install`, `postinstall`) | **warn**; **block** if the previous release had none and this one is under a week old |
| Build provenance | **warn** if the previous release had it and this one lost it |
| Deprecated release | **warn** |
| Known vulnerabilities, with exploit signals | **block** if actively exploited, **warn** for high severity, otherwise a note; a fixed version is offered |
| Not a registry package (a URL, `github:` shorthand, a path) | **warn**: its contents cannot be checked |

The verdict is the worst result: `allow`, `warn` or `block`. A lookup that fails (registry or OSV
unreachable) is a **warn**, never a silent pass. `--offline` skips OSV and says so.

Exit codes: `0` clear, `3` something to check first, `4` blocked (see
[exit codes](automation.md#exit-codes)). `--output-format json` prints the report.

## In your agent

- **MCP tool `guardPackage`** (and `POST /packages/guard` over HTTP): the
  [MCP server](../integrations/mcp-server.md) tool description tells an agent to call it before
  adding any dependency.
- **Claude Code hook.** `autoremediator guard-hook` is a `PreToolUse` hook for the Bash tool. It reads
  the command Claude Code is about to run, and for `npm`, `pnpm`, `yarn` or `bun` install commands
  checks each package: a blocked package is denied with the reasons and the alternative, a warning
  asks the person, anything else runs as usual. Commands that do not install anything are not
  touched, and a cheap text check keeps the package manager from starting for every command.
  Install it with `npx autoremediator init --guard` (writes `.claude/settings.json`, keeping your
  other settings), or get it from the [Claude Code plugin](../integrations/coding-agents.md#claude-code-plugin).

## Limits

- **The hook is a guard rail, not a security boundary.** It understands plain install commands
  (`npm install a b@1`, `pnpm add -D x`). A command built from variables, a subshell or a script is
  not parsed. If the hook itself fails, the command goes through.
- The look-alike check uses a fixed list of popular names and edit distance. It has no download
  counts, so a legitimate small package with a name near a popular one gets a warning.
- Release age uses `--min-age-hours` (default 72), not your package manager's own cooldown setting.
- Hooks for Cursor and Copilot, a pnpm `.pnpmfile.cjs` and a Yarn plugin are not provided. Use the
  MCP tool or run `guard` yourself.
