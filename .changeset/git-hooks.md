---
"autoremediator": minor
---

Git hooks: `autoremediator hook install|uninstall|status` and the `installHooks` SDK function.

- `pre-push` runs `autoremediator diff --ci` against the upstream and blocks a push whose lockfile or
  manifest changes introduce vulnerabilities (only when the verdict is `DEGRADED`; a missing CLI, no
  network, an error or a timeout never blocks). `post-merge` prints a one-line advisory after a merge
  that changed dependencies and never fails the merge. Both skip at once when no manifest or lockfile
  changed, and honour `AUTOREMEDIATOR_SKIP_HOOKS=1` and `AUTOREMEDIATOR_HOOK_TIMEOUT`.
- Detects husky, lefthook, the pre-commit framework or plain git hooks (honouring `core.hooksPath` and
  worktrees) and writes what each expects, as a marked block or a named entry. It never overwrites a
  file it cannot merge into safely (reported as a conflict), and `uninstall` removes only what it wrote.
- Same approval rules as `init`: nothing is written without `--yes` or a confirmation, exit `3` when
  not confirmed; `hook status` exits `1` on drift. Options: `--hooks`, `--manager`, `--yes`,
  `--output-format`.
- New catalog operation `installHooks` (CLI and SDK only; deliberately not an MCP tool or HTTP route).
- New guide: `docs/guides/git-hooks.md`.
