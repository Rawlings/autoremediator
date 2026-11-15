---
"autoremediator": patch
---

Publish with `pnpm publish` so `catalog:` ranges are resolved. `autoremediator@0.21.2` was published with `yaml: "catalog:"` in its dependencies and cannot be installed with npm; CI now packs every published package and fails on an unresolved `catalog:` or `workspace:` range.

Also hardens inputs found by CodeQL: comment-command parsing, git remote and branch arguments, registry paths and error text returned over HTTP.

The GitHub Action gains a `package` input (an npm spec or tarball to install instead of the bundled version), and the reusable workflow a `build-from-source` input; the integration smoke tests use them so they test the code in the change, not the last release.
