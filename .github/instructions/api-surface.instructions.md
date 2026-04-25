---
description: Public API stability and cross-surface contract rules for SDK, CLI, MCP, and OpenAPI.
applyTo: packages/core/src/{api,cli,mcp,openapi,platform}/**/*.ts
---

# API Surface Instructions

## Public Entry Points

The package exposes primary remediation and patch lifecycle programmatic entry points:

```ts
import {
	remediate,
	planRemediation,
	remediateFromScan,
	listPatchArtifacts,
	inspectPatchArtifact,
	validatePatchArtifact,
} from "autoremediator";
```

- `remediate(cveId, options?)` — remediates a single CVE in a target project.
- `planRemediation(cveId, options?)` — runs a non-mutating remediation preview for a single CVE.
- `remediateFromScan(inputPath, options?)` — parses a scanner output file and remediates all discovered CVEs.
- `listPatchArtifacts(options?)` — lists stored patch artifacts and manifest metadata.
- `inspectPatchArtifact(patchFilePath, options?)` — inspects a patch artifact and unified-diff validity.
- `validatePatchArtifact(patchFilePath, options?)` — validates manifest presence and dependency drift.

## Type Naming

| Old name (< 0.2)    | Current name          |
|---------------------|-----------------------|
| `HealOptions`       | `RemediateOptions`    |
| `HealReport`        | `RemediationReport`   |
| `heal()`            | `remediate()`         |
| `healFromScanFile()`| `remediateFromScan()` |

## Schema Versioning

All report types carry `schemaVersion: "1.0"`. Do not increment this value without a formal migration strategy and CHANGELOG entry.

## Stability Guarantees

The following are stable public API:

- `remediate`, `planRemediation`, `remediateFromScan`, `listPatchArtifacts`, `inspectPatchArtifact`, `validatePatchArtifact`, `toCiSummary`, `ciExitCode`
- `RemediateOptions`, `RemediationReport`, `ScanOptions`, `ScanReport`, `CiSummary`
- All types re-exported from `packages/core/src/platform/types.ts`

The following are **internal** and must not be imported by consumers:

- Anything under `packages/core/src/remediation/tools/`
- Anything under `packages/core/src/intelligence/sources/`
- `packages/core/src/platform/config.ts` (use `RemediateOptions.llmProvider` instead)

## MCP and OpenAPI Surfaces

The MCP server (`packages/core/src/mcp/server.ts`) and OpenAPI server (`packages/core/src/openapi/server.ts`) wrap the stable API only. They must not bypass `api/index.ts` to call internal modules directly.

When adding a new public operation, keep naming and request/response shape aligned across SDK, CLI JSON, MCP, and OpenAPI in the same change set.

Public-operation reviews must also verify adjacent delivery surfaces when applicable:

- GitHub action/reusable workflow option forwarding for CLI/API-exposed options
- GitHub App repository-config bridge and runtime forwarding
- Docs, llms, and AGENTS references for the changed contract

Do not assume an untouched surface is unaffected; explicitly verify and document why.

## CLI Compatibility

The CLI (`autoremediator` bin) is a stable interface. Option names and exit codes must not change without a CHANGELOG note.

Patch lifecycle CLI commands (`patches list`, `patches inspect`, `patches validate`) are part of the public automation contract and must remain machine-readable with `--output-format json`.
