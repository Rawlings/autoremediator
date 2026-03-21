# API and SDK

## Public APIs

- `remediate(cveId, options?)`
- `remediateFromScan(inputPath, options?)`
- `toCiSummary(scanReport)`
- `ciExitCode(summary)`

Backward-compatible aliases:

- `heal`
- `healFromScanFile`

## Options

Key options:

- `cwd`
- `packageManager`
- `dryRun`
- `skipTests`
- `llmProvider`
- `policyPath`
- `patchesDir`

Scan-only options:

- `format`
- `writeEvidence`
