---
description: Test placement, scope, and verification requirements for feature work.
applyTo: packages/core/src/**/*.test.ts,packages/core/src/**/*.ts
---

# Testing Instructions

## Scope

Feature changes require matching tests. Tests should verify behavior, safety gates, and cross-surface consistency where relevant.

## Placement

- Keep unit tests colocated with implementation files as `<name>.test.ts`. Do not invent new suffixes; real-process or real-git tests are marked in their describe title, not in the file name. Test helpers live in `testing/` next to the feature, or in `shared/testing/` when two features use them (see `code-structure`).
- Add integration-style tests in the owning surface module (API, CLI, MCP, OpenAPI) when contracts change.
- Keep scanner/intelligence fixtures near adapter/source tests.

## Minimum Expectations by Change Type

- Internal behavior change: add/adjust unit tests for success and failure paths.
- Public contract change: add/adjust tests in every affected surface.
- Patch/fallback change: verify unresolved semantics and validation-phase outputs.
- Policy/safety change: verify blocked/allowed behavior and deterministic outcomes.

## Guardrails

- Do not add feature behavior without tests.
- Do not replace assertions with snapshots when explicit assertions are practical.
- Keep tests deterministic; avoid network dependence unless explicitly mocked/isolated.

## Verification

- Run typecheck and tests for core package.
- Ensure new/changed tests fail before fix and pass after fix when practical.
