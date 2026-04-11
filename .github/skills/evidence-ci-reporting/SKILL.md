---
name: evidence-ci-reporting
argument-hint: Describe the evidence schema or CI summary contract change needed.
description: Use when changing evidence logs, summary schemas, CI output, or deterministic exit behavior.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: contributor
user-invocable: true
---

# Evidence and CI Reporting

## Scope

**Contributor tooling.** This skill governs the contracts that evidence logs and CI summaries expose to downstream consumers (CI pipelines, audit systems, dashboards). Read it when changing schema fields, exit codes, or summary structure. The evidence itself is written at runtime, but this skill is about what shape it takes — a contributor concern, not an execution concern.

## When to Use

- Updating `packages/core/src/platform/evidence.ts` structures.
- Updating `ScanReport`/`CiSummary` contracts in `packages/core/src/api/index.ts`.
- Changing CI exit code semantics.

## Inputs

- Tool-level outcomes.
- run-level metadata.

## Outputs

- Stable evidence files.
- Stable report schema fields for CI consumers.

## Guardrails

- Preserve schemaVersion handling.
- Keep CI summaries compact and deterministic.
- Never remove fields without migration note.

## Verification Checklist

- Evidence file still serializes and writes.
- CI summary remains backward compatible.
- Exit code behavior matches documented policy.
