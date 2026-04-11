---
description: Documentation consistency and change-to-doc mapping rules for runtime and public surface updates.
applyTo: README.md,CONTRIBUTING.md,AGENTS.md,llms.txt,packages/core/README.md,packages/core/CHANGELOG.md,packages/core/llms.txt,packages/docs/README.md,packages/docs/content/**/*.md,.github/**/*.md
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

- `packages/docs/README.md`
- `packages/docs/content/getting-started.md`
- `packages/docs/content/cli.md`
- `packages/docs/content/api-sdk.md`
- `packages/docs/content/scanner-inputs.md`
- `packages/docs/content/policy-and-safety.md`
- `packages/docs/content/integrations.md`
- `packages/docs/content/contributor-guide.md`
- `packages/docs/content/changelog.md`

Governance docs:

- `.github/instructions/*.md`
- `.github/skills/**/SKILL.md`

## Change-to-Docs Mapping

When public SDK API changes:

- Update `packages/docs/content/api-sdk.md`.
- Update `packages/docs/content/getting-started.md` examples if user entry points changed.
- Update `packages/core/llms.txt` and `llms.txt` API references.
- Update `README.md` if feature summary materially changed.

When CLI commands/options/output change:

- Update `packages/docs/content/cli.md`.
- Update `packages/docs/content/getting-started.md` command examples if needed.
- Update `packages/core/llms.txt` CLI examples.

When orchestration/tool order/fallback behavior changes:

- Update `AGENTS.md`.
- Update `packages/docs/content/policy-and-safety.md`.
- Update `packages/core/llms.txt` remediation order/tool section.
- Update matching instruction and skill files.

When MCP/OpenAPI surfaces change:

- Update `packages/docs/content/integrations.md`.
- Update `packages/docs/content/api-sdk.md` when request/response semantics change.
- Update `AGENTS.md` mode descriptions if exposed operations changed.

When scanner/intelligence behavior changes:

- Update `packages/docs/content/scanner-inputs.md` and/or `packages/docs/content/policy-and-safety.md`.
- Update `packages/core/llms.txt` source/format sections.

When release version/changelog changes:

- Update `packages/core/CHANGELOG.md` and `packages/docs/content/changelog.md` together.
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
