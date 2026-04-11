---
name: architecture-conventions
argument-hint: Describe the file/module change and expected placement rules.
description: Use when modifying module structure, adding new source files, moving files between modules, or validating that code adheres to the feature-first layout.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: contributor
user-invocable: true
---

# Architecture Conventions

## Scope

**Contributor tooling.** This skill governs how the codebase is organized, not how the tool runs. Read it when adding new source files, moving modules, resolving import path questions, or deciding which module a new concern belongs in. It has no bearing on the tool's runtime behavior.

For public naming conventions and API contract consistency across surfaces, use `public-api-governance`.

When used for feature work, run this preflight before proposing new artifacts:

1. Identify candidate existing files/modules that can absorb the change.
2. Decide whether refactor/consolidation resolves the concern without adding new artifacts.
3. Create a new file/directory only when reuse/refactor cannot preserve clear module boundaries.
4. Record explicit rationale when step 3 is chosen.

## When to Use

- Adding new source files anywhere under `packages/core/src/`.
- Moving or renaming modules.
- Resolving import path questions.
- Reviewing whether a file belongs in the right module.
- Running consolidation-first preflight before feature category selection.

## Module Map

```
packages/core/src/
  platform/       ← cross-cutting infrastructure (types, config, policy, evidence)
  intelligence/   ← CVE data acquisition and enrichment
    sources/      ← per-source clients (osv, github-advisory, nvd, registry)
  scanner/        ← scan input parsing and normalization
    adapters/     ← per-format adapters (npm-audit, yarn-audit, sarif)
  remediation/    ← patching pipeline, tool implementations, patch utilities
    tools/        ← individual AI tool definitions (lookup-cve, apply-version-bump, …)
  mcp/            ← Model Context Protocol server surface
  openapi/        ← OpenAPI / HTTP server surface
  api/            ← public SDK surface (index.ts thin export surface + focused modules)
  cli/            ← CLI surface (index.ts thin export surface + focused modules)
```

## Inputs

- Proposed file path.
- Module responsibility description.

## Outputs

- Correct target module for the file.
- Updated barrel `index.ts` if needed.

## Guardrails

- Each module owns one concern; cross-module calls go through the module's barrel `index.ts`.
- `platform/` has no imports from other `packages/core/src/` modules — it is a leaf dependency.
- `intelligence/` imports only from `platform/`.
- `scanner/` imports only from `platform/`.
- `remediation/` imports from `platform/`, `intelligence/`, and `scanner/`.
- `api/index.ts` and `cli/index.ts` import from `remediation/` and `scanner/` barrels only.
- `mcp/` and `openapi/` import only from `api/index.ts`.
- Never import from `dist/` at runtime.

## Verification Checklist

- New file is placed in the module that matches its single responsibility.
- Reuse/refactor/create decision is explicit; new artifacts include rationale.
- No circular dependencies introduced (use `tsc --noEmit` to verify).
- Barrel `index.ts` updated if the new export is part of the public module surface.
- Import paths use `.js` extension (ESM Node.js requirement).
