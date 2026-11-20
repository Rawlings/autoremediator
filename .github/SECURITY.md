# Security policy

## Supported versions

Only the latest published version receives security fixes. This covers every artifact built from
this repository: the `autoremediator` npm package, `@autoremediator/github-app`, the Docker image on
`ghcr.io`, the GitHub Action (`@v0` and the exact tags), the VS Code extension and the Claude Code
plugin under `integrations/`.

## Reporting a vulnerability

Do not open a public issue. Report it privately through
[GitHub security advisories](https://github.com/Diffra/autoremediator/security/advisories/new).

Reports are acknowledged within 5 business days. Confirmed issues are targeted for a fix within 30
days.

## What to expect from the tool

The guarantees, trust boundaries and the hosts Autoremediator contacts are documented in
[Safety](../docs/safety.md).

## What a release is built from

- The npm package is built in a job that holds no publishing credential, then published from the
  exact tarball it produced by a second job, with npm provenance (`npm audit signatures` and
  `npm view autoremediator dist.attestations` show it).
- Releases are made from `master` only, by workflows that need the `npm-publish` environment.
- Third-party actions in these workflows are pinned to commit hashes, and Dependabot proposes updates
  a week after they are released.
- The Claude Code plugin and the VS Code extension run a pinned release of the CLI, never `latest`.

