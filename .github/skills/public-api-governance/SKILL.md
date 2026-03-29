---
name: public-api-governance
argument-hint: Describe the public API naming or schema change and affected surfaces.
description: Use when defining or changing canonical public API terminology, option naming, report field naming, and cross-surface consistency across SDK, CLI, MCP, OpenAPI, and docs.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: contributor
user-invocable: true
---

# Public API Governance

## Scope

Contributor tooling for the public contract. This skill governs naming, schema shape, and growth strategy for all user-facing API surfaces:

- SDK exports and option/report types
- CLI flags and output contracts
- MCP tool input schemas
- OpenAPI request/response schemas
- User and contributor documentation

This skill does not govern remediation pipeline step order or internal tool algorithm details.

## Canonical Naming Rules

- Use one canonical term per concept across all public surfaces.
- Use positive boolean semantics (`runTests`, `evidence`) and avoid inverted naming.
- Use camelCase for SDK fields and JSON properties.
- Use kebab-case for CLI flags that map directly to canonical SDK fields.
- Keep concept families aligned:
  - policy: `policy`
  - tests: `runTests`
  - evidence: `evidence`
  - patch summaries: `patchCount`, `patchesDir`
  - remediation aggregates: `strategyCounts`, `dependencyScopeCounts`, `unresolvedByReason`

## Extensibility Rules

- Prefer bounded domain grouping before adding many new root fields.
- Add fields only when the concept is user-visible and stable enough to document.
- Avoid synonym growth for already-canonical concepts.
- Any new field must be introduced with exact naming parity in SDK, CLI, MCP, OpenAPI, and docs in the same change set.

## Required Update Set

For any public API naming/schema change, update all of the following:

1. `packages/core/src/platform/types.ts`
2. `packages/core/src/api.ts`
3. `packages/core/src/cli.ts`
4. `packages/core/src/mcp/server.ts`
5. `packages/core/src/openapi/server.ts`
6. Relevant tests under `packages/core/src/**/*.test.ts`
7. All affected markdown docs in the repository

## Guardrails

- Do not leave mixed terminology in the same release.
- Do not add compatibility aliases unless explicitly requested.
- Preserve `schemaVersion: "1.0"` unless a formal schema migration is approved.
- Keep MCP and OpenAPI surfaces wrapped around stable API entry points from `api.ts`.

## Verification Checklist

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm docs:build`
- Repo-wide grep confirms no stale public names remain.
