# Autoremediator Copilot Instructions

This repository uses a skills-first governance model for agentic behavior.

## Core Rules

- Prefer deterministic workflows over ad hoc prompt decisions.
- Use project skills in .github/skills for scoped task execution.
- Follow global guardrails in .github/instructions before editing runtime logic.
- Respect policy defaults from packages/core/src/platform/policy.ts and never bypass them in generated changes.
- Preserve CLI/API compatibility when updating remediation behavior.

## Agent Autopilot Contract

Before proposing or creating any new file, directory, or markdown artifact, run this decision order:

1. Reuse existing module/file/section when it can reasonably hold the change.
2. Refactor and consolidate existing structure when reuse is possible but current organization is too large or mixed-concern.
3. Create a new artifact only when reuse/refactor would violate separation of concerns or dependency boundaries.

When step 3 is chosen, include explicit rationale in the task outcome (what was evaluated, why existing structure could not absorb the change, and why the new artifact has a single clear responsibility).

Do not default to append-only docs or "new file first" implementation patterns.

## Multi-Agent Handoff Contract

This repository uses three logical contributor roles for autonomous feature/refactor work:

- Planner agent: scopes work, runs consolidation-first analysis, and produces task handoff packets.
- Developer agent: executes task packets while preserving architecture boundaries and contracts.
- Architect agent: validates structure before execution and after implementation, and can require consolidation/refactor changes.

These roles may be fulfilled by separate agents or by one agent operating in explicit phases, but all handoff gates still apply.

### Handoff Gates

1. Planner -> Architect pre-check:
	- Planner must provide reuse/refactor/create analysis for each proposed artifact.
	- Planner must include explicit rationale for any new file/directory/doc.
	- Architect must approve or request consolidation/refactor before implementation starts.
2. Architect -> Developer execution handoff:
	- Developer receives approved task packet with boundaries, acceptance criteria, and forbidden shortcuts.
	- Developer must not expand scope or create new artifacts outside the packet without re-routing to planner + architect.
3. Developer -> Architect completion review:
	- Architect verifies module boundaries, DRY, separation of concerns, and docs consolidation behavior.
	- Architect can reject completion when implementation introduced avoidable sprawl.
4. Architect -> Planner closure:
	- Planner confirms all approved tasks are complete and governance/docs updates are coherent.

### Task Packet Requirements

Every planner handoff packet must include:

- Reuse candidates evaluated.
- Refactor/consolidation decision.
- New artifact rationale (only when creation is required).
- Files expected to change.
- Required skills/instructions for execution.
- Acceptance checks for architecture, tests, and docs.

### Custom Agent Files

Use these workspace custom agents under `.github/agents/` for governed handoffs:

- `Planner`: `.github/agents/planner.agent.md`
- `Developer`: `.github/agents/developer.agent.md`
- `Architect`: `.github/agents/architect.agent.md`

Use the names exactly as defined above when invoking subagents.

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

1. Planner phase: run preflight with `architecture-conventions` and `documentation-governance.instructions.md` (consolidation-first decision), then produce task packet.
2. Architect phase: review planner packet and enforce module/documentation boundaries before execution.
3. Developer phase: apply `feature-implementation` and `test-governance` while staying within approved packet.
4. Architect phase: run final structural review and require fixes for avoidable sprawl.
5. Planner phase: run `feature-completeness-gate.instructions.md` and governance validation before completion.

## Agentic Remediation Order

Use `.github/instructions/tool-contracts.instructions.md` as the canonical source for runtime tool order.
Use `.github/instructions/orchestration.instructions.md` for runtime sequencing behavior and fallback details.

## Evidence Requirement

Any change affecting agent flow, patching strategy, or safety checks must preserve evidence output in packages/core/src/platform/evidence.ts.
