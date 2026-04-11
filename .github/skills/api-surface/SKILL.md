---
name: api-surface
argument-hint: Describe the API contract change and compatibility constraints.
description: Use when changing the public SDK API (packages/core/src/api/index.ts), exported types, function signatures, or the OpenAPI/HTTP server surface.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: contributor
user-invocable: true
---

# API Surface

## Scope

**Contributor tooling.** This skill governs what the tool exposes to callers — SDK functions, exported types, OpenAPI routes. Read it when adding or renaming public functions, changing report schemas, or updating the HTTP server surface. It does not govern internal pipeline logic or module internals.

For naming canon, terminology normalization, and cross-surface parity rules, pair this skill with `public-api-governance`.

## When to Use

- Modifying `packages/core/src/api/index.ts` exports.
- Adding or renaming public-facing functions.
- Changing the shape of `RemediationReport`, `ScanReport`, `CiSummary`, or `RemediateOptions`.
- Updating the OpenAPI spec or HTTP route handlers in `packages/core/src/openapi/`.
- Adding new exported types to the package.

## Inputs

- Current `packages/core/src/api/index.ts` exports.
- Consumer-visible types in `packages/core/src/platform/types.ts`.
- OpenAPI spec (when applicable).

## Outputs

- Backward-compatible (or intentionally breaking) API changes with updated types.
- Updated `packages/core/src/openapi/server.ts` route if schema changes.
- Updated README / `llms.txt` when public interface changes.

## Public API Reference

```ts
// Primary entry points
remediate(cveId: string, options?: RemediateOptions): Promise<RemediationReport>
planRemediation(cveId: string, options?: RemediateOptions): Promise<RemediationReport>
remediateFromScan(inputPath: string, options?: ScanOptions): Promise<ScanReport>

// CI helpers
toCiSummary(report: ScanReport): CiSummary
ciExitCode(summary: CiSummary): number

// Re-exported types
RemediateOptions, RemediationReport, ScanOptions, ScanReport, CiSummary
CveDetails, AffectedPackage, InventoryPackage, VulnerablePackage, PatchResult, PatchStrategy
ScanInputFormat
```

## Guardrails

- `packages/core/src/api/index.ts` and sibling API modules must import only from stable internal module barrels.
- Never expose internal module paths in public exports.
- `schemaVersion` fields must remain `"1.0"` unless a formal versioning process is followed.
- Breaking changes must be documented in CHANGELOG and reflected in `llms.txt`.
- `ciExitCode` must remain a pure function (no side effects).

## Verification Checklist

- `tsc --noEmit` passes with no errors on `packages/core/src/api/index.ts`.
- All types re-exported from `packages/core/src/api/index.ts` are resolvable by consumers.
- OpenAPI spec (if generated) accurately reflects parameter and response shapes.
- README quick-start example still compiles against updated API.
