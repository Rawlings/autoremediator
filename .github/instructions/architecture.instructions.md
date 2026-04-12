---
description: Architecture boundaries, file placement, and import constraints for core runtime modules.
applyTo: packages/core/src/**/*.ts
---

# Architecture Instructions

## Module Boundaries

The source tree is organized into feature-first modules. Each module has a single responsibility:

| Module              | Responsibility                                                   |
|---------------------|------------------------------------------------------------------|
| `packages/core/src/platform/`     | Cross-cutting infrastructure: types, config, policy, evidence    |
| `packages/core/src/intelligence/` | CVE data acquisition and enrichment from external sources        |
| `packages/core/src/scanner/`      | Scanner output parsing and CVE extraction                        |
| `packages/core/src/remediation/`  | Remediation pipeline, AI tool implementations, patch utilities   |
| `packages/core/src/detection/`    | [reserved — no implementation; routing anchor only]              |
| `packages/core/src/exposure/`     | [reserved — no implementation; routing anchor only]              |
| `packages/core/src/mcp/`          | MCP server — exposes tools to LLM hosts                          |
| `packages/core/src/openapi/`      | OpenAPI / HTTP server surface                                    |
| `packages/core/src/api/`          | Public SDK surface (index.ts + focused modules)                 |
| `packages/core/src/cli/`          | CLI surface (index.ts + focused modules)                        |

Keep this module split stable. New capabilities should usually extend an existing module rather than creating cross-cutting shortcuts.

## Dependency Rules

- `platform/` has **no** imports from other `packages/core/src/` modules.
- `intelligence/` imports from `platform/` only.
- `scanner/` imports from `platform/` only.
- `remediation/` imports from `platform/`, `intelligence/`, and `scanner/`.
- `detection/` [reserved — no implementation; routing anchor only].
- `exposure/` [reserved — no implementation; routing anchor only].
- `api/index.ts` and `cli/index.ts` import from `remediation/` and `scanner/` barrels.
- `mcp/` and `openapi/` import from `api/index.ts` only.
- Entrypoint index.ts files should be thin export surfaces; move orchestration logic into dedicated modules.

If adding a new dependency edge, document why the existing boundaries are insufficient and update this file in the same change.

Violations of these rules must be treated as architectural defects and resolved before merging.

## Extension vs New Artifact Rubric

Before creating any new file or directory, run this decision sequence:

1. Reuse check: confirm whether an existing file in the owning module can absorb the behavior.
2. Consolidation check: if the target file is mixed-concern or large, split by concern first, then add behavior.
3. Boundary check: ensure the concern stays within existing dependency rules.
4. Creation check: create a new artifact only when steps 1-3 fail to provide a clean fit.

Required rationale for new artifacts:

- What existing files were evaluated.
- Why reuse/refactor did not fit.
- Why the new artifact has one clear responsibility.

Invalid rationale examples:

- "This looked cleaner in a new file."
- "Might be useful later."

Valid rationale examples:

- Existing file already handles unrelated concerns and would become multi-domain if extended.
- Refactor would create forbidden dependency direction or circular imports.

## External Service Dependencies

When calling any external HTTP service (GitHub, GitLab, npm registry, osv.dev, etc.):

1. Check whether an official or widely-adopted npm SDK exists first (e.g., `@octokit/rest` for GitHub, `@gitbeaker/rest` for GitLab).
2. Prefer the SDK. Do not implement authentication headers, request building, response parsing, or pagination by hand when an SDK handles it.
3. Shelling out to a CLI tool (`gh`, `glab`, `curl`) is only acceptable when no npm SDK exists and the CLI is a documented first-class interface for the operation.
4. Raw `fetch` against a JSON API is only acceptable for simple, narrow, one-off lookups where no SDK exists and the surface is stable (e.g., a read-only registry metadata endpoint).

Violating this rule by reimplementing SDK functionality via raw fetch or subprocess is an architectural defect and must be fixed before merging.

## File Placement Rules

- New type definitions go in `packages/core/src/platform/types.ts`.
- New CVE source clients go in `packages/core/src/intelligence/sources/`.
- New scanner adapters go in `packages/core/src/scanner/adapters/`.
- New agent tool implementations go in `packages/core/src/remediation/tools/`.
- Shared patch/diff utilities go in `packages/core/src/remediation/strategies/`.

Cross-surface contract types should remain centralized in `packages/core/src/platform/types.ts`.

## File Structure and Size Guardrails

Default expectation: keep files focused and composable.

- Prefer small, purpose-built modules over large multi-concern files.
- Avoid "god files" that combine parsing, orchestration, validation, I/O, and formatting in one place.
- Extract shared logic into reusable helpers rather than duplicating branches across modules.

Size thresholds:

- Target most runtime files to stay below ~400 LOC.
- If a file grows beyond ~600 LOC, split by concern before adding more behavior.
- If a single function grows beyond ~80-100 LOC or has multiple logical phases, break it into named helpers.

Refactor triggers that require decomposition:

- Multiple unrelated responsibilities in one file.
- Repeated logic blocks across the same file or neighboring modules.
- Large switch/if trees handling different domains that can be isolated.
- New feature work that would push an already large file significantly larger.

When splitting files:

- Keep public behavior unchanged unless the task requires behavior changes.
- Preserve existing public exports and compatibility.
- Add/update tests around extracted behavior.
- Prefer feature-local helper files before introducing new cross-module dependencies.
- Do not create new directories when a file-level extraction in the existing module is sufficient.

## Import Style

- Always use `.js` extensions in import paths (ESM Node.js requirement).
- Cross-module imports use the module's barrel: `import { ... } from "../intelligence/index.js"`.
- Never import internal submodule paths from outside the module.

Avoid circular imports between feature modules; if a cycle appears, extract shared shape/logic into `platform/`.

## DRY and Separation of Concerns

- Apply DRY for domain logic and validation rules; avoid copy/paste of decision paths.
- Keep I/O boundaries explicit: parsing, decision logic, and output formatting should be isolated where practical.
- Keep policy evaluation, remediation strategy selection, and reporting composition in separate units where possible.
- Prefer composition of small functions over deep nesting in one function.

## Enforcement

Use the `governance-check` skill checklist to validate governance files are present, well-formed, and aligned with runtime code.
Governance verification is advisory by default and should surface issues clearly without silently mutating behavior.

## Change Checklist

- Verify file placement and dependency direction before merge.
- Update tests in affected modules.
- Update contributor-facing docs if architecture behavior changed.
- If touching a high-LOC file, evaluate whether splitting by concern is required in the same PR.
- Confirm repeated logic was centralized rather than duplicated.
