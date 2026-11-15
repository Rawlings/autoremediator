---
name: safety-validation-gates
argument-hint: Describe the validation gate or rollback behavior to change.
description: Use when modifying validation behavior, test gating, or rollback/failure semantics.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: runtime
user-invocable: true
---

# Safety Validation Gates

## Scope

**Runtime behavior.** This skill governs the validation and rollback logic that runs after each remediation attempt. Read it when changing how test failures are handled, what counts as a successful apply, or how rollback is triggered. It does not govern API shape or module organization.

## When to Use

- Updating test execution behavior in `packages/core/src/remediation/tools/apply-version-bump.ts`.
- Changing patch or bump validation gates.
- Modifying rollback behavior.

## Inputs

- patch/bump apply results.
- test command output.

## Outputs

- Deterministic pass/fail validation state.
- Structured error details for failures.

## Guardrails

- Never report success when validation failed.
- Never swallow test command failures.
- Keep failure handling non-destructive and explicit.
- Route install/test validation through the resolved package manager; do not hardcode npm.

## Verification Checklist

- Validation fields exist in results.
- Failures are propagated to summary/error outputs.
- Evidence contains validation outcomes.
