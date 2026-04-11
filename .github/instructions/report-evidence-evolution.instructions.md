---
description: Stability and evolution rules for remediation reports, CI summaries, and evidence artifacts.
applyTo: packages/core/src/{platform,api,cli,mcp,openapi}/**/*.ts,packages/docs/content/{api-sdk,cli,policy-and-safety,changelog}.md
---

# Report and Evidence Evolution

## Scope

Changes to report fields, CI summaries, or evidence output must remain deterministic and backward-aware.

## Stability Rules

- Preserve `schemaVersion: "1.0"` unless formal migration is approved.
- Prefer additive fields over renames/removals.
- Keep machine-readable summary fields stable (`strategyCounts`, `dependencyScopeCounts`, `unresolvedByReason`).
- Ensure unresolved/failure semantics remain explicit.

## Required Updates

When report/evidence fields change:

- Update shared types.
- Update affected API/CLI/MCP/OpenAPI surfaces.
- Update docs references in `api-sdk.md`, `cli.md`, and `policy-and-safety.md`.
- Update changelog entries with user-visible impact.

## Guardrails

- Never hide failures by coercing unresolved outcomes into success.
- Do not introduce silent field semantics changes.
- Keep CI-facing outputs deterministic and machine-readable.

## Verification

- Ensure tests cover new/changed report semantics.
- Ensure docs describe field intent and expected values.
