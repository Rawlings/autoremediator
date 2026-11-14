---
"autoremediator": minor
---

`guard` reaches the other places a package gets added.

- **`autoremediator guard --git-diff [--base <ref>] [--include-transitive]`**, SDK `guardGitDiff`.
  Checks the dependencies a change adds or upgrades in `package.json` (and, with
  `--include-transitive`, packages only the lockfile gained) instead of ones you name. A branch is
  compared at the merge base. Useful in a pre-commit hook or a pull request check, and for agents that
  edit a manifest instead of running an install command. `guard` now takes zero package names when
  `--git-diff` is given.
- **Cursor and GitHub Copilot hooks.** `autoremediator guard-hook --host cursor|copilot|claude-code`
  (default `claude-code`, unchanged) answers each host's hook format: Cursor's
  `beforeShellExecution` `{ permission, user_message, agent_message }` and Copilot's `preToolUse`
  `{ permissionDecision, permissionDecisionReason }`. `init --guard` now writes `.cursor/hooks.json`
  and `.github/hooks/autoremediator-guard.json` (for the `copilot` and `vscode` hosts), merging with
  hooks you already have. Formats taken from the vendors' documentation; not yet run inside Cursor or
  Copilot.
- **pnpm.** For pnpm projects `init --guard` writes a `.pnpmfile.cjs` whose `readPackage` hook runs
  `guard` on dependencies not yet in `pnpm-lock.yaml` and stops the install on a block. Run
  `pnpm install` once afterwards: pnpm records the pnpmfile's checksum in the lockfile. An existing
  pnpmfile is never edited.
- **Package manager cooldown.** The default minimum release age is now the larger of 72 hours and the
  cooldown your package manager enforces (`minimumReleaseAge`, `npmMinimalAgeGate`, `min-release-age`,
  bun's `minimumReleaseAge`), honouring its exemptions. `--min-age-hours` is still used as given.
- No Yarn Berry plugin: its documented hooks cannot tell a newly added dependency from an existing
  one. `guard --git-diff` reads `yarn.lock`.
