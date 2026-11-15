---
description: Documentation consistency and change-to-doc mapping rules for runtime and public surface updates.
applyTo: README.md,CONTRIBUTING.md,AGENTS.md,llms.txt,packages/*/README.md,docs/**/*.md,.github/**/*.md
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

Top level:

- `README.md`: overview, quick start, documentation map
- `CONTRIBUTING.md`, `AGENTS.md`, `llms.txt`, `.github/SECURITY.md`
- `packages/github-app/README.md`, `packages/vscode-extension/README.md`
  (`packages/core/README.md` and `llms.txt` are copied from the root at pack time; do not edit them)

User docs (`docs/`, indexed by `docs/README.md`):

- Learn: `getting-started.md`, `how-it-works.md`, `safety.md`
- Guides: `guides/scanners.md`, `guides/automation.md`, `guides/patch-generation.md`, `guides/offline.md`
- Reference: `reference/cli.md`, `reference/sdk.md`, `reference/policy-file.md`, `reference/environment.md`
- Integrations: `integrations/github-action.md`, `integrations/github-app.md`, `integrations/mcp-server.md`, `integrations/http-server.md`
- Contributors: `contributing/architecture.md`

Governance docs:

- `.github/instructions/*.md`
- `.github/skills/**/SKILL.md`

Delivery-touchpoint files that must be checked when behavior or contracts change:

- `action.yml`
- `.github/workflows/reusable-remediate-from-audit.yml`
- `packages/github-app/src/**/*.ts` (for config and forwarding parity)

## Change-to-Docs Mapping

When the public SDK API changes:

- Update `docs/reference/sdk.md` and the examples in `docs/getting-started.md`.
- Update `llms.txt`, and `README.md` if the feature summary materially changed.

When CLI commands, options or output change:

- Update `docs/reference/cli.md`, and `llms.txt` CLI examples.

When orchestration, strategy order or fallback behavior changes:

- Update `docs/reference/modes.md`, `docs/how-it-works.md` and `docs/reference/policy-file.md`.
- Update matching instruction and skill files.

When the MCP or OpenAPI surfaces change:

- Update `docs/integrations/mcp-server.md` and `docs/integrations/http-server.md`.
- Update the Mode 4 and Mode 5 entries in `docs/reference/modes.md` if exposed operations changed.

When GitHub Action or reusable workflow inputs change:

- Update `docs/integrations/github-action.md` and `docs/guides/automation.md`.
- Update README references if setup expectations changed.

When GitHub App runtime or config behavior changes:

- Update `docs/integrations/github-app.md`.
- Update `docs/reference/modes.md` when trigger or delivery semantics changed.

When scanner or intelligence behavior changes:

- Update `docs/guides/scanners.md`, `docs/guides/offline.md` and `docs/safety.md` (network access).

When guarantees or trust boundaries change:

- Update `docs/safety.md`.

When the release version changes:

- Keep `llms.txt` aligned with current capabilities, and pin examples that name a release tag.

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
