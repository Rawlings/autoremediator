---
name: governance-check
argument-hint: Describe what governance consistency or policy alignment to verify.
description: Use when verifying that all governance files are present, correctly structured, and internally consistent with the runtime codebase.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: contributor
user-invocable: true
---

# Governance Check

## Scope

**Contributor tooling.** This skill defines the full procedure for auditing the governance health of the repository. Run it when onboarding, after adding files to `.github/`, or whenever you need to confirm that instructions, skills, and source code are in sync. It does not alter runtime behavior — it is read-only verification.

## When to Use

- After adding or renaming a SKILL.md file.
- After modifying `.github/instructions/` files.
- After restructuring `packages/core/src/` modules.
- Before opening a PR that touches governance, API surface, or pipeline logic.
- When `copilot-instructions.md` is updated.

## Inputs

- The full `.github/` directory tree.
- `packages/core/src/remediation/pipeline.ts` (tool map source of truth).
- `.github/instructions/tool-contracts.instructions.md` (canonical tool list).
- `.github/instructions/orchestration.instructions.md` (prompt placeholder list).

## Outputs

A pass/fail report listing any missing files, malformed frontmatter, missing sections, or contract mismatches. No files are written or modified.

## Required Governance Files

Every file in this list must exist at the repository root:

```
.github/copilot-instructions.md
AGENTS.md
.github/instructions/agent-safety.instructions.md
.github/instructions/tool-contracts.instructions.md
.github/instructions/orchestration.instructions.md
.github/instructions/architecture.instructions.md
.github/instructions/api-surface.instructions.md
.github/skills/agent-orchestration/SKILL.md
.github/skills/cve-intelligence-sources/SKILL.md
.github/skills/semver-remediation/SKILL.md
.github/skills/patch-generation-strategy/SKILL.md
.github/skills/safety-validation-gates/SKILL.md
.github/skills/scanner-parser-integration/SKILL.md
.github/skills/evidence-ci-reporting/SKILL.md
.github/skills/architecture-conventions/SKILL.md
.github/skills/mcp-tool-registration/SKILL.md
.github/skills/api-surface/SKILL.md
.github/skills/governance-check/SKILL.md
```

## SKILL.md Structural Rules

For every directory under `.github/skills/`, a `SKILL.md` must exist and must satisfy all of the following:

**Frontmatter** (YAML block between `---` delimiters at the top of the file):
- `name:` — matches the directory name
- `description:` — single-line summary, starts with "Use when"
- `metadata.scope:` — exactly `runtime` or `contributor`

**Required sections** (each must appear as a level-2 heading `##`):
- `## Scope` — one-paragraph explanation of what the skill does and does not cover
- `## When to Use` — bullet list of trigger conditions
- `## Inputs` — what information the agent needs before starting
- `## Outputs` — what the agent produces or changes
- `## Guardrails` — constraints that must never be violated
- `## Verification Checklist` — step-by-step checks to confirm the work is correct

## Orchestration Placeholder Rules

`.github/instructions/orchestration.instructions.md` must contain all of the following template placeholders:

```
{{cveId}}
{{cwd}}
{{dryRun}}
{{skipTests}}
{{policyPath}}
{{patchesDir}}
```

## Tool Contract Rules

`packages/core/src/remediation/pipeline.ts` defines the runtime tool map via entries of the form `"tool-name": someTool`. Every tool name found there must:

1. Appear in `.github/instructions/tool-contracts.instructions.md` as a list entry (`- tool-name`).
2. Be present in the canonical tool order below.

**Canonical tool order** (must all appear in tool-contracts.instructions.md):

```
lookup-cve
check-inventory
check-version-match
find-fixed-version
apply-version-bump
fetch-package-source
generate-patch
apply-patch-file
```

## Guardrails

- Do not modify any files while running this check — it is read-only.
- Report every failure found; do not stop at the first one.
- A missing file is always a hard failure, not a warning.
- Scope mismatches (e.g. `metadata.scope: foo`) are hard failures.

## Verification Checklist

- [ ] All required governance files exist.
- [ ] Every `.github/skills/*/SKILL.md` has valid frontmatter (`name`, `description`, `scope`).
- [ ] Every SKILL.md scope is exactly `runtime` or `contributor`.
- [ ] Every SKILL.md contains all six required `##` sections.
- [ ] `copilot-instructions.md` lists all skills in the correct group (runtime vs contributor).
- [ ] All orchestration placeholders are present in `orchestration.instructions.md`.
- [ ] All tools in `pipeline.ts` are listed in `tool-contracts.instructions.md`.
- [ ] All eight canonical tools appear in `tool-contracts.instructions.md`.
