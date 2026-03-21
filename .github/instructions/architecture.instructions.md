# Architecture Instructions

## Module Boundaries

The source tree is organized into feature-first modules. Each module has a single responsibility:

| Module              | Responsibility                                                   |
|---------------------|------------------------------------------------------------------|
| `packages/core/src/platform/`     | Cross-cutting infrastructure: types, config, policy, evidence    |
| `packages/core/src/intelligence/` | CVE data acquisition and enrichment from external sources        |
| `packages/core/src/scanner/`      | Scanner output parsing and CVE extraction                        |
| `packages/core/src/remediation/`  | Remediation pipeline, AI tool implementations, patch utilities   |
| `packages/core/src/mcp/`          | MCP server — exposes tools to LLM hosts                          |
| `packages/core/src/openapi/`      | OpenAPI / HTTP server surface                                    |
| `packages/core/src/api.ts`        | Public SDK entry point                                           |
| `packages/core/src/cli.ts`        | CLI entry point                                                  |

## Dependency Rules

- `platform/` has **no** imports from other `packages/core/src/` modules.
- `intelligence/` imports from `platform/` only.
- `scanner/` imports from `platform/` only.
- `remediation/` imports from `platform/`, `intelligence/`, and `scanner/`.
- `api.ts` and `cli.ts` import from `remediation/` and `scanner/` barrels.
- `mcp/` and `openapi/` import from `api.ts` only.

Violations of these rules must be treated as architectural defects and resolved before merging.

## File Placement Rules

- New type definitions go in `packages/core/src/platform/types.ts`.
- New CVE source clients go in `packages/core/src/intelligence/sources/`.
- New scanner adapters go in `packages/core/src/scanner/adapters/`.
- New agent tool implementations go in `packages/core/src/remediation/tools/`.
- Shared patch/diff utilities go in `packages/core/src/remediation/strategies/`.

## Import Style

- Always use `.js` extensions in import paths (ESM Node.js requirement).
- Cross-module imports use the module's barrel: `import { ... } from "../intelligence/index.js"`.
- Never import internal submodule paths from outside the module.

## Enforcement

Use the `governance-check` skill checklist to validate governance files are present, well-formed, and aligned with runtime code.
Governance verification is advisory by default and should surface issues clearly without silently mutating behavior.
