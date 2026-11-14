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
| Release age (default 72 hours, or your package manager's own cooldown if that is longer; `--min-age-hours`, `0` turns it off) | **block**, and the newest old-enough version is offered |
| Install scripts (`preinstall`, `install`, `postinstall`) | **warn**; **block** if the previous release had none and this one is under a week old |
| Build provenance | **warn** if the previous release had it and this one lost it |
| Deprecated release | **warn** |
| Known vulnerabilities, with exploit signals | **block** if actively exploited, **warn** for high severity, otherwise a note; a fixed version is offered |
| Not a registry package (a URL, `github:` shorthand, a path) | **warn**: its contents cannot be checked |

The verdict is the worst result: `allow`, `warn` or `block`. A lookup that fails (registry or OSV
unreachable) is a **warn**, never a silent pass. `--offline` skips OSV and says so.

Exit codes: `0` clear, `3` something to check first, `4` blocked (see
[exit codes](automation.md#exit-codes)). `--output-format json` prints the report.

## What a change adds

Not every dependency arrives through an install command: an agent can edit `package.json`, and a
person can merge a branch. `--git-diff` checks the dependencies a change adds or moves, whichever way
they got there.

```bash
autoremediator guard --git-diff                      # the working tree against HEAD (pre-commit)
autoremediator guard --git-diff --base origin/main   # this branch against where it left main (CI)
autoremediator guard --git-diff --include-transitive # also packages only the lockfile gained
```

It reads the changed `package.json` files (and lockfiles with `--include-transitive`) with the same
comparison as [`scanDelta`](../reference/sdk.md), and guards what was added or upgraded. A branch name
is compared at the merge base, so work that landed on the base since you branched is not blamed on you.
`workspace:`, `link:`, `file:`, `portal:` and `catalog:` entries are listed as skipped; a git or URL
dependency gets the usual "cannot be checked" warning. Removed and downgraded entries and peer
dependencies are not checked. Run it from the repository root. The exit codes are the same as for a
named package (`0`, `3`, `4`), and `--output-format json` prints `{ baseRef, checked, skipped, verdict, reports }`.

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
- **Cursor hook.** `autoremediator guard-hook --host cursor` answers a `beforeShellExecution` hook with
  Cursor's `{ "permission": "allow" | "deny" | "ask", "user_message", "agent_message" }`.
  `init --guard` adds it to `.cursor/hooks.json` (keeping your hooks), with a `matcher` so that only
  commands that mention `npm`, `pnpm`, `yarn` or `bun` start it. Format:
  [Cursor hooks](https://cursor.com/docs/agent/hooks).
- **GitHub Copilot hook** (Copilot CLI, the Copilot cloud agent, and the Copilot harness in VS Code).
  `autoremediator guard-hook --host copilot` answers a `preToolUse` hook with
  `{ "permissionDecision": "deny" | "ask", "permissionDecisionReason" }`, and prints nothing to allow,
  so Copilot's own permission flow stays in charge. `init --guard` writes
  `.github/hooks/autoremediator-guard.json` for the `copilot` and `vscode` hosts. Where Copilot cannot
  ask a person (the cloud agent, CLI autopilot) an `ask` becomes a deny. Format:
  [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference).
- **pnpm.** For pnpm projects `init --guard` also writes a `.pnpmfile.cjs` whose `readPackage` hook runs
  `guard` on the dependencies pnpm is about to add (what `pnpm add` is adding, or what was edited into
  `package.json`) and stops the install when one is blocked. It compares with `pnpm-lock.yaml`:
  a dependency is new when no lockfile entry pairs its name with its specifier. `AUTOREMEDIATOR_GUARD=off`
  skips it for one install. Hooks:
  [pnpmfile](https://pnpm.io/pnpmfile).

Commands in agent hooks still see only what the person or agent typed. For everything else, run
`guard --git-diff` in a pre-commit hook or in CI.

How far each of these has been run:

| Piece | Format taken from | Run for real |
| ----- | ----------------- | ------------ |
| `guard --git-diff` | git | yes, against git and the live registry and OSV |
| `.pnpmfile.cjs` | pnpm docs | yes, with pnpm 12 (`pnpm add`, a hand edit plus `pnpm install`, a block, a warning) |
| `guard-hook --host cursor` | Cursor docs | the hook's input and output only; not inside Cursor |
| `guard-hook --host copilot` | Copilot docs | the hook's input and output only; not inside Copilot CLI, the cloud agent or VS Code |

## Limits

- **The hook is a guard rail, not a security boundary.** It understands plain install commands
  (`npm install a b@1`, `pnpm add -D x`). A command built from variables, a subshell or a script is
  not parsed. If the hook itself fails, the command goes through.
- The look-alike check uses a fixed list of popular names and edit distance. It has no download
  counts, so a legitimate small package with a name near a popular one gets a warning.
- Release age is the larger of `--min-age-hours` (default 72) and the cooldown your package manager
  enforces (`minimumReleaseAge`, `npmMinimalAgeGate`, `min-release-age`, bun's `minimumReleaseAge`),
  except for packages it exempts. A value you pass yourself is used as given.
- **Cursor and Copilot.** The input a Copilot `preToolUse` hook gets for its shell tool
  (`toolArgs` as a JSON string with a `command` field) is shown in GitHub's own debugging example but
  not defined in the reference, so the hook reads both that and the `PreToolUse` alias form
  (`tool_input`). Copilot also reads a repository's `.claude/settings.json`; if you install the Claude
  Code hook and the Copilot one, Copilot may run both. Cursor treats output that is not valid JSON as a
  block, so this hook always prints JSON, including `{ "permission": "allow" }`; whether Cursor treats
  that `allow` as skipping its own command approval is not documented.
- **pnpm.** pnpm loads the pnpmfile in separate processes for separate hooks, so the check lives
  entirely in `readPackage`. It covers the project at the lockfile's root, not other workspace
  projects, and sees nothing on a first install with no lockfile (it says so). A pnpmfile's checksum
  is recorded in `pnpm-lock.yaml`: after `init --guard`, run `pnpm install` once and commit the lockfile,
  or `pnpm install --frozen-lockfile` fails with a `pnpmfileChecksum` mismatch; the same happens when
  the pinned `autoremediator` range in the file changes. An existing `.pnpmfile.cjs` (or a `.pnpmfile.mjs`,
  which pnpm prefers) is never edited: `init` reports it and you add the check by hand.
- **No Yarn plugin.** Yarn Berry's documented plugin hooks are synchronous validators
  (`validateProject`, `validateWorkspace`) and `afterAllInstalled`; its docs do not say how to tell a
  dependency a person just added from one already in the lockfile, nor what a thrown error does, and
  its plugin reference says hooks may change. `guard --git-diff` reads `yarn.lock` and covers Yarn.
