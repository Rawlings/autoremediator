# API Surface Instructions

## Public Entry Points

The package exposes three primary programmatic entry points:

```ts
import { remediate, planRemediation, remediateFromScan } from "autoremediator";
```

- `remediate(cveId, options?)` — remediates a single CVE in a target project.
- `planRemediation(cveId, options?)` — runs a non-mutating remediation preview for a single CVE.
- `remediateFromScan(inputPath, options?)` — parses a scanner output file and remediates all discovered CVEs.

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

- `remediate`, `planRemediation`, `remediateFromScan`, `toCiSummary`, `ciExitCode`
- `RemediateOptions`, `RemediationReport`, `ScanOptions`, `ScanReport`, `CiSummary`
- All types re-exported from `packages/core/src/platform/types.ts`

The following are **internal** and must not be imported by consumers:

- Anything under `packages/core/src/remediation/tools/`
- Anything under `packages/core/src/intelligence/sources/`
- `packages/core/src/platform/config.ts` (use `RemediateOptions.llmProvider` instead)

## MCP and OpenAPI Surfaces

The MCP server (`packages/core/src/mcp/server.ts`) and OpenAPI server (`packages/core/src/openapi/server.ts`) wrap the stable API only. They must not bypass `api.ts` to call internal modules directly.

## CLI Compatibility

The CLI (`autoremediator` bin) is a stable interface. Option names and exit codes must not change without a CHANGELOG note.
