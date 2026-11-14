---
description: Documentation consistency and change-to-doc mapping rules for runtime and public surface updates.
applyTo: README.md,CONTRIBUTING.md,AGENTS.md,llms.txt,packages/core/README.md,packages/core/CHANGELOG.md,packages/core/llms.txt,docs/**/*.md,.github/**/*.md
---

# Documentation Governance

## Scope

Documentation updates are mandatory for feature work. This instruction defines what must be updated for each feature class so docs and governance stay aligned by default.

Before creating a new markdown file, agents must first attempt:

1. Reuse an existing canonical document section.
2. Restructure/merge sections within an existing canonical document.
3. Create a new document only if steps 1-2 cannot preserve clarity and separation of concerns.

Do not default to append-only growth when section-level consolidation is feasible.

## Canonical Documentation Inventory

Core references:

- `README.md`
- `CONTRIBUTING.md`
- `AGENTS.md`
- `llms.txt`
- `packages/core/README.md`
- `packages/core/CHANGELOG.md`
- `packages/core/llms.txt`

User docs:

- `docs/usage.md`
- `docs/policy.md`
- `docs/integrations.md`
- `docs/architecture.md`

Governance docs:

- `.github/instructions/*.md`
- `.github/skills/**/SKILL.md`

Delivery-touchpoint docs that must be checked when behavior/contracts change:

- `action.yml`
- `.github/workflows/reusable-remediate-from-audit.yml`
- `packages/github-app/src/**/*.ts` (for config/forwarding parity)

## Change-to-Docs Mapping

When public SDK API changes:

- Update `docs/usage.md`.
- Update `docs/usage.md` examples if user entry points changed.
- Update `packages/core/llms.txt` and `llms.txt` API references.
- Update `README.md` if feature summary materially changed.

When CLI commands/options/output change:

- Update `docs/usage.md`.
- Update `docs/usage.md` command examples if needed.
- Update `packages/core/llms.txt` CLI examples.

When orchestration/tool order/fallback behavior changes:

- Update `AGENTS.md`.
- Update `docs/policy.md`.
- Update `packages/core/llms.txt` remediation order/tool section.
- Update matching instruction and skill files.

When MCP/OpenAPI surfaces change:

- Update `docs/integrations.md`.
- Update `docs/usage.md` when request/response semantics change.
- Update `AGENTS.md` mode descriptions if exposed operations changed.

When GitHub Action/reusable workflow inputs change:

- Update `docs/integrations.md` input reference.
- Update `docs/usage.md` recommended workflow snippets when behavior changed.
- Update README references if setup expectations changed.

When GitHub App runtime/config behavior changes:

- Update `docs/integrations.md` GitHub App sections.
- Update `docs/policy.md` repo-policy guidance as applicable.
- Update `AGENTS.md` mode behavior when trigger or delivery semantics changed.

When scanner/intelligence behavior changes:

- Update `docs/usage.md` and/or `docs/policy.md`.
- Update `packages/core/llms.txt` source/format sections.

When release version/changelog changes:

- Keep `packages/core/llms.txt` and `llms.txt` references aligned with current capabilities.

## Guardrails

- Do not merge feature work with stale command or API names in docs.
- Keep public naming canon consistent across SDK, CLI, MCP, OpenAPI, and docs.
- Documentation updates are required in the same PR as behavior changes.
- If behavior is internal-only and user-invisible, document rationale in PR summary and skip user docs intentionally.
- Avoid creating new docs for topics already covered in canonical inventory files.
- When creating a new markdown file is necessary, include explicit rationale in the task outcome.

## Verification

- Run docs build validation.
- Confirm changed paths are reflected in corresponding docs mapping above.
- Confirm no stale references remain in markdown files.
- Confirm consolidation-first decision was applied before any new markdown file creation.
- Confirm touchpoint parity checks were completed across SDK, CLI, MCP, OpenAPI, GitHub action/workflows, GitHub App, and docs/governance artifacts.
