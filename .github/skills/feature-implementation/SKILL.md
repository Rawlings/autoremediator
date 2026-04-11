---
name: feature-implementation
argument-hint: Describe the feature and affected surfaces so mandatory update bundles can be applied.
description: Use when implementing a feature so code, tests, docs, and governance updates are applied consistently by default.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: contributor
user-invocable: true
---

# Feature Implementation

## Scope

Contributor workflow skill for feature execution. It enforces feature classification and the required update bundle so implementation is complete by default.

## When to Use

- Any feature request affecting `packages/core/src/**`.
- Any change that introduces/modifies public operations.
- Any change likely to affect docs/governance/release notes.

## Inputs

- Requested feature behavior.
- Affected files/surfaces.
- Existing governance instructions and skills.

## Outputs

- Feature category selection.
- Complete update bundle across code, tests, docs, governance, and release notes.
- Verification summary with any intentional exclusions.

## Feature Category Decision

- `internal-tool`: runtime behavior changed, no new public operation.
- `public-operation`: SDK/CLI/MCP/OpenAPI contracts changed.
- `bugfix-refactor`: no public behavior change.

## Mandatory Bundle Matrix

For `internal-tool`:

- Code + tests required.
- Update governance contracts when tool behavior changed.
- Update user docs only when behavior is externally visible.

For `public-operation`:

- Keep SDK/CLI/MCP/OpenAPI names and semantics aligned.
- Update shared types/contracts.
- Add/update tests across impacted surfaces.
- Update docs (`api-sdk.md`, `cli.md`, `integrations.md`, `getting-started.md` as applicable).
- Update changelog.

For `bugfix-refactor`:

- Code + tests required.
- Docs/governance updates only when behavior/contract changed.

## Related Skills

Use with:

- `architecture-conventions`
- `api-surface`
- `public-api-governance`
- `mcp-tool-registration`
- `evidence-ci-reporting`
- `changeset-writing`
- `governance-check`
- `test-governance`

## Guardrails

- Do not ship partial surface updates for public operations.
- Do not skip tests for feature changes.
- Do not skip documentation for user-visible behavior changes.
- Keep unresolved outcomes explicit and machine-readable.

## Verification Checklist

- Feature category selected.
- Required update bundle completed.
- Typecheck/tests/docs build validated.
- Governance check executed and results reviewed.
