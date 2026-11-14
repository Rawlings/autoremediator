---
"autoremediator": minor
---

Correctness fixes for installed-package inventory, suppressions and registries:

- Every installed version of a package is now tracked. Previously only the last copy of a name was
  kept, so a vulnerable transitive copy next to a fixed direct one was missed. Each copy is matched
  and reported separately; the direct dependency is the copy that satisfies the declared range.
- The SBOM marks status per installed copy (`name@version`) instead of per package name.
- A suppressed CVE still changes nothing, but the report now lists each installed copy it covers as a
  suppressed result, so VEX output reports `not_affected` and the SBOM reports `suppressed` as
  documented.
- Registry lookups, the supply-chain trust gate and source downloads use the registry from `.npmrc`
  (`registry`, `@scope:registry`, `_authToken`, `_auth`) and `npm_config_registry`, instead of a
  hard-coded `registry.npmjs.org`. Credentials go only to URLs under the registry they were
  configured for.
- Source tarballs for patch generation are downloaded with `fetch` instead of `curl`, so tokens never
  appear on a command line, and are verified against the registry's `integrity`/`shasum` before
  extraction.
