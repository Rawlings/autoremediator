---
name: changeset-writing
argument-hint: Describe the release scope, user-facing impact, and candidate semver bump.
description: Use when deciding patch vs minor releases and writing changelog/changeset entries for packages/core.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: contributor
user-invocable: true
---

# Changeset Writing

## Scope

Contributor tooling for release notes and versioning decisions.

Use this skill when:

- Bumping `packages/core` version.
- Writing `packages/core/CHANGELOG.md` entries.
- Deciding patch vs minor for non-breaking changes.
- Verifying changelog language focuses on user-visible impact.

This skill is for release communication and semver hygiene, not runtime implementation.

## Public-Impact Rule

Write changelog entries in terms users care about:

- Feature behavior.
- Public API contracts.
- CLI/MCP/OpenAPI surface behavior.
- Reporting/evidence outputs consumed by users or CI.

Do not highlight internal-only refactors, file moves, test relocation, or module decomposition unless they directly change user-visible behavior.

## Required Wording Pattern

When describing architecture-oriented cleanup that affected structure but not behavior, keep changelog phrasing outcome-oriented and user-facing.

Preferred contributor reminder:

- "I’ll split this entry file further by extracting the two main flows into dedicated modules and leaving index.ts as a thin export surface."

Use this as implementation guidance during coding, but keep release notes focused on external impact.

## Semver Guidance

- Patch (`x.y.Z`): Bug fixes, docs-only clarifications, or non-breaking corrections with no meaningful feature expansion.
- Minor (`x.Y.z`): Backward-compatible feature additions, notable behavior improvements, new user-facing options, improved report fields, or meaningful cross-surface parity improvements.
- Major is out of scope for this skill unless explicitly requested.

## Required Update Set

For core releases, update all of:

1. `packages/core/package.json` version
2. `packages/core/CHANGELOG.md` with a new top section

If release impacts public behavior across surfaces, verify docs are aligned in:

- `packages/docs/content/api-sdk.md`
- `packages/docs/content/cli.md`
- `packages/docs/content/getting-started.md`
- `packages/docs/content/integrations.md`
- `packages/docs/content/policy-and-safety.md`
- `packages/docs/content/changelog.md`
- `README.md`
- `packages/core/llms.txt`
- `llms.txt`

## Changelog Style Rules

- Start with what changed for users, not implementation details.
- Keep entries high-level and scannable.
- Use clear verbs: "Added", "Improved", "Expanded", "Aligned", "Fixed".
- Avoid internal jargon (`barrel`, `file split`, `module move`) unless it changed external behavior.
- Do not claim breaking changes for patch/minor.

## Verification Checklist

- Version bump matches declared scope (patch or minor).
- Changelog section is present and at top.
- Entry text mentions user-visible impact only.
- Required docs and llms files are updated for user-visible feature changes.
- `pnpm --dir packages/core typecheck`
- `pnpm --dir packages/core test`
