---
name: agent-orchestration
argument-hint: Describe the orchestration change and desired pipeline behavior.
description: Use when changing agent system instructions, tool registration, sequence rules, or fallback branching.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: runtime
user-invocable: true
---

# Agent Orchestration

## Scope

**Runtime behavior.** This skill governs how the agent pipeline executes at runtime. Read it when diagnosing pipeline logic, reordering tools, or changing how the agent decides between version-bump and patch fallback paths. It does not cover codebase structure or public API contracts.

## When to Use

- Editing `packages/core/src/remediation/pipeline.ts` prompt or tools map.
- Reordering tools.
- Changing fallback branching logic.

## Inputs

- Tool map in `packages/core/src/remediation/pipeline.ts`.
- Orchestration instructions in `.github/instructions/orchestration.instructions.md`.

## Outputs

- Updated deterministic orchestration logic.
- Updated instruction contracts when behavior changes.

## Guardrails

- Keep canonical order aligned with tool-contracts.instructions.md.
- Do not remove fallback branch for unresolved packages.
- Preserve maxSteps safety cap.
- Ensure package manager is resolved once per run and propagated to tool calls.
- Keep transitive remediation aligned with package-manager-native override fields before patch fallback.

## Verification Checklist

- Tool names in code and contracts match.
- Prompt placeholders resolve correctly at runtime.
- packageManager placeholder resolves correctly at runtime.
- apply-version-bump, apply-package-override, and fallback chain are all reachable.
- apply-patch-file path is package-manager aware (native pnpm/yarn where supported, compatibility fallback otherwise).
