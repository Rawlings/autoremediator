---
"autoremediator": minor
---

`diet`: most future CVEs are avoided by depending on less.

- **`autoremediator diet`**, SDK `analyzeDependencies`, MCP tool `analyzeDependencies` and
  `POST /packages/diet`. Read-only and offline. It reports, per package (monorepo workspaces
  included): declared dependencies nothing uses, classified `certainly-unused`, `probably-unused`
  or `used-indirectly` with the reason and evidence; micro-packages a Node built-in now replaces
  (a curated table in `replaceable.json`, each row citing the API, the Node versions that have it
  and a one-line migration, matched against `engines.node` or `.nvmrc`, never claimed when the
  project's floor is lower or unknown); the same package installed at several versions in the
  lockfile (npm and pnpm) with who pulls each and whether a dedupe stays within semver range; and a
  0-100 attack-surface score with its written-out formula and breakdown.
- **`autoremediator diet --apply`**, SDK `removeUnusedDependencies` (command line and SDK only).
  Removes only the `certainly-unused` dependencies through npm or pnpm, runs the verifier (scope,
  policy, a frozen install, and the type check and tests when asked) and restores manifests,
  lockfile and `node_modules` if any check fails. It never touches probably-unused dependencies,
  replaceable packages or duplicates.
