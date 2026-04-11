---
description: Mandatory update bundles for feature implementation so consistency is enforced by default.
applyTo: packages/core/src/**/*.ts,.github/**/*.md,packages/docs/**/*.md,README.md,CONTRIBUTING.md,AGENTS.md,llms.txt
---

# Feature Completeness Gate

## Scope

Every feature request must classify work and satisfy a mandatory update bundle. This prevents partial implementations that skip tests, docs, or governance updates.

## Feature Categories

- `internal-tool`: runtime behavior change without new public surface.
- `public-operation`: any new/changed SDK, CLI, MCP, or OpenAPI contract.
- `bugfix-refactor`: no public behavior change.

## Mandatory Update Bundle

For `internal-tool`:

- Runtime code updates.
- Tests for new behavior and failure paths.
- Governance docs updates when tool contracts/order/safety changed.
- User docs only if behavior is externally visible.

For `public-operation`:

- SDK, CLI, MCP, and OpenAPI parity updates.
- Shared types/contract updates.
- Tests across affected surfaces.
- Docs updates (`api-sdk.md`, `cli.md`, `integrations.md`, `getting-started.md` as applicable).
- Governance updates for API/tool contracts.
- Changelog updates.

For `bugfix-refactor`:

- Code + tests required.
- Docs/governance updates required only when user-visible behavior or contracts changed.

## Maintainability Gate

Feature completeness also includes code-structure quality:

- Start with consolidation-first decisions: reuse existing module/file, then refactor, then create new artifact only when required by separation of concerns.
- Do not keep adding behavior into already-large, multi-concern files when extraction is practical.
- If feature work materially increases a large file, split by concern in the same PR.
- Prefer reusable helpers over repeated logic blocks.
- Keep orchestration, validation, and output formatting separated where practical.

When not splitting a large file, include explicit rationale in PR notes.

## Guardrails

- Do not ship public-surface changes on a single surface only.
- Do not skip tests for feature work.
- Do not skip docs for user-visible behavior changes.
- Keep schemaVersion unchanged unless formal migration process is approved.

## Verification Checklist

- Feature category identified.
- Mandatory bundle satisfied for category.
- Typecheck/tests/docs build pass.
- Changelog updated for user-visible features.
- Governance references updated when contracts changed.
- High-LOC touched files evaluated for decomposition and DRY cleanup.
