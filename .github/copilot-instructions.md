# Autoremediator Copilot Instructions

This repository uses a skills-first governance model for agentic behavior.

## Core Rules

- Prefer deterministic workflows over ad hoc prompt decisions.
- Use project skills in .github/skills for scoped task execution.
- Follow global guardrails in .github/instructions before editing runtime logic.
- Respect policy defaults from packages/core/src/platform/policy.ts and never bypass them in generated changes.
- Preserve CLI/API compatibility when updating remediation behavior.

## Skill Categories

Skills are divided into two groups by purpose. Always select from the appropriate group.

### Runtime Skills

Use these when diagnosing or changing **how the tool executes** — pipeline logic, data acquisition, version matching, patching, validation, and input parsing. These skills have `scope: runtime`.

| Skill | When to reach for it |
|---|---|
| `agent-orchestration` | Pipeline order, tool map, fallback branching |
| `cve-intelligence-sources` | OSV / GitHub Advisory / NVD lookup and merge logic |
| `semver-remediation` | Vulnerable range matching, safe-version selection, bump application |
| `patch-generation-strategy` | LLM-generated diff fallback, confidence thresholds |
| `safety-validation-gates` | Test gating, rollback, failure semantics |
| `scanner-parser-integration` | npm-audit / yarn-audit / SARIF parsing, format detection, CVE extraction |

### Contributor Skills

Use these when **building or extending the tool** — adding files, changing public APIs, registering new MCP tools, or modifying output contracts. These skills have `scope: contributor`.

| Skill | When to reach for it |
|---|---|
| `architecture-conventions` | File placement, module layout, import graph rules |
| `api-surface` | SDK functions, exported types, OpenAPI/HTTP routes |
| `public-api-governance` | Canonical naming, schema consistency, and scalable public API evolution |
| `mcp-tool-registration` | MCP tool schemas, names, result shapes |
| `evidence-ci-reporting` | Evidence log fields, CI summary schema, exit codes |
| `changeset-writing` | Semver bump choice and public-impact-first changelog/changeset writing |
| `feature-implementation` | Mandatory feature category and complete update bundle execution |
| `test-governance` | Test scope, placement, and verification standards for feature changes |
| `governance-check` | Verify governance files are present, correctly structured, and in sync with source |

## Default Feature Workflow

For feature requests, default to this flow unless explicitly told otherwise:

1. Apply `feature-implementation` first to classify change scope.
2. Apply `test-governance` for required test updates.
3. Apply `documentation-governance.instructions.md` and `feature-completeness-gate.instructions.md` for mandatory docs/governance updates.
4. Run governance validation before completion.

## Agentic Remediation Order

1. lookup-cve
2. check-inventory
3. check-version-match
4. find-fixed-version
5. apply-version-bump
6. apply-package-override (when transitive and safe override is available)
7. fetch-package-source (fallback only)
8. generate-patch (fallback only)
9. apply-patch-file (fallback only)

Do not reorder these steps without updating .github/instructions/tool-contracts.instructions.md.

## Evidence Requirement

Any change affecting agent flow, patching strategy, or safety checks must preserve evidence output in packages/core/src/platform/evidence.ts.
