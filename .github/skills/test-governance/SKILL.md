---
name: test-governance
argument-hint: Describe the feature change so required test scope and placement can be validated.
description: Use when defining or reviewing test coverage for feature work to keep behavior, safety, and contract verification consistent.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: contributor
user-invocable: true
---

# Test Governance

## Scope

Contributor skill for test strategy and placement. Ensures each feature change has deterministic, meaningful coverage.

## When to Use

- New feature implementation.
- Public contract/surface changes.
- Remediation pipeline, policy, or fallback behavior changes.

## Inputs

- Changed files and surfaces.
- Existing tests in affected modules.
- Relevant governance instructions.

## Outputs

- Test plan for changed behavior.
- Added/updated tests aligned to feature category.
- Verification checklist results.

## Test Expectations by Change

- Internal behavior change: success + failure-path unit tests.
- Public operation change: API/CLI/MCP/OpenAPI contract tests as applicable.
- Patch/fallback changes: validation phase and unresolved reason coverage.
- Policy/safety changes: blocked/allowed behavior and dry-run constraints.

When code is split for maintainability:

- Add/adjust tests around extracted helper units.
- Preserve behavior coverage while reducing reliance on only broad end-to-end assertions.

## Placement

- Keep unit tests colocated (`*.test.ts`).
- Keep integration contract tests in owning surface modules.

## Guardrails

- Do not rely on network for deterministic test suites unless isolated.
- Do not replace clear assertions with broad snapshots without need.
- Do not merge feature behavior changes without tests.
- Do not leave large, nested logic untested at helper/function boundaries when decomposition occurred.

## Verification Checklist

- Tests cover success and failure paths.
- Contract changes validated in all affected surfaces.
- Core test suite runs clean.
