---
"autoremediator": patch
---

Fix transitive overrides on pnpm 11 and later, and reading pnpm 12 lockfiles.

- **Overrides on pnpm 11+:** pnpm 11 and later read `overrides` from `pnpm-workspace.yaml` and ignore the
  `pnpm` field of `package.json`. The override tool wrote to `package.json`, so the install succeeded,
  nothing changed, and the result still said `applied`. It now writes `overrides` to
  `pnpm-workspace.yaml` (keeping its comments) on pnpm 11+, and restores the file on rollback. After the
  install it also checks that `pnpm-lock.yaml` records the override; if it does not, the change is
  reverted and reported as `override-apply-failed` instead of success.
- **pnpm 12 lockfiles:** pnpm 11+ writes two YAML documents (one for pnpm itself, then the project's).
  The delta scanner and the lock graph parsed the file as one document, failed silently and returned
  nothing, so `diff`, `guard --git-diff --include-transitive` and `incident` saw no packages. Both now
  read the project document.
