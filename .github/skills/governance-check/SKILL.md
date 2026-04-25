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

By default this governance review is advisory (warn-first). Teams can choose stricter enforcement externally (CI policy), but this skill itself remains read-only and non-mutating.

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
.github/instructions/documentation-governance.instructions.md
.github/instructions/feature-completeness-gate.instructions.md
.github/instructions/testing.instructions.md
.github/instructions/report-evidence-evolution.instructions.md
.github/instructions/deprecation.instructions.md
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
.github/skills/feature-implementation/SKILL.md
.github/skills/test-governance/SKILL.md
.github/skills/governance-check/SKILL.md
```

Documentation governance references must also exist:

```
README.md
CONTRIBUTING.md
AGENTS.md
llms.txt
packages/core/llms.txt
packages/core/CHANGELOG.md
packages/docs/content/api-sdk.md
packages/docs/content/cli.md
packages/docs/content/integrations.md
packages/docs/content/policy-and-safety.md
packages/docs/content/contributor-guide.md
packages/docs/content/changelog.md
packages/docs/content/getting-started.md
packages/docs/content/scanner-inputs.md
packages/docs/content/agent-ecosystems.md
packages/docs/README.md
packages/core/README.md
action.yml
.github/workflows/reusable-remediate-from-audit.yml
```

## Cross-Surface Touchpoint Audit

When governance changes involve public behavior/contracts, verify there is explicit coverage or rationale for all applicable touchpoints:

- SDK (`packages/core/src/api/**`)
- CLI (`packages/core/src/cli/**`)
- MCP (`packages/core/src/mcp/**`)
- OpenAPI (`packages/core/src/openapi/**`)
- GitHub Action/workflows (`action.yml`, `.github/workflows/**`)
- GitHub App bridge (`packages/github-app/src/**`)
- Docs/readmes/AGENTS/llms/changelog

If a surface is not updated, the review must still record `verified-not-affected`.

## Instruction Frontmatter Rules

For every file under `.github/instructions/`, frontmatter must include:

- `description:` with a concise one-line summary
- `applyTo:` with non-empty target patterns

`applyTo` patterns must match at least one real repository file.

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
{{runTests}}
{{policy}}
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
apply-package-override
fetch-package-source
generate-patch
apply-patch-file
```

Patch lifecycle operation naming canon must also appear in governance references:

```
listPatchArtifacts
inspectPatchArtifact
validatePatchArtifact
```

## Guardrails

- Do not modify any files while running this check — it is read-only.
- Report every failure found; do not stop at the first one.
- A missing file is always a hard failure, not a warning.
- Scope mismatches (e.g. `metadata.scope: foo`) are hard failures.
- Treat documentation and naming drift as explicit findings even when advisory.

## Verification Checklist

- [ ] All required governance files exist.
- [ ] Every `.github/skills/*/SKILL.md` has valid frontmatter (`name`, `description`, `scope`).
- [ ] Every SKILL.md scope is exactly `runtime` or `contributor`.
- [ ] Every SKILL.md contains all six required `##` sections.
- [ ] Every `.github/instructions/*.md` file has `description` and `applyTo` frontmatter.
- [ ] Every instruction `applyTo` pattern matches at least one file.
- [ ] `copilot-instructions.md` lists all skills in the correct group (runtime vs contributor).
- [ ] All orchestration placeholders are present in `orchestration.instructions.md`.
- [ ] All tools in `pipeline.ts` are listed in `tool-contracts.instructions.md`.
- [ ] All nine canonical runtime tools appear in `tool-contracts.instructions.md`.
- [ ] Patch lifecycle operation names are consistent across AGENTS, docs, and tool contracts.
- [ ] Touchpoint coverage is explicit across SDK/CLI/MCP/OpenAPI/GitHub delivery/GitHub App/docs artifacts for user-visible contract changes.
