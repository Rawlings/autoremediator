# Offline use

Advisory data normally comes from public APIs. For air-gapped or reproducible runs, supply it from
a file.

## Sources

| Data | Source |
| ---- | ------ |
| Affected ranges, fixed versions | OSV, GitHub Advisory Database |
| Severity | NVD |
| Exploitation | CISA Known Exploited Vulnerabilities |
| Exploit probability | FIRST EPSS |
| Candidate versions | npm registry (from your `.npmrc`) |

Optional credentials raise rate limits: `AUTOREMEDIATOR_NVD_API_KEY` and `GITHUB_TOKEN`.
`AUTOREMEDIATOR_EPSS_API` points at a different EPSS endpoint. See
[Environment variables](../reference/environment.md).

## Run from a snapshot

```bash
autoremediator CVE-2021-23337 --offline --intelligence-snapshot ./intel.json
```

`--offline` skips every advisory request. Local inventory and registry version resolution still run.
Without `--offline`, the snapshot is ignored.

## Snapshot format

A JSON object keyed by CVE id. Each entry is a full record or a short form.

```json
{
  "CVE-2021-23337": {
    "packageName": "lodash",
    "vulnerableRange": "<4.17.21",
    "firstPatchedVersion": "4.17.21",
    "severity": "HIGH",
    "epssScore": 0.31,
    "cisaKev": false
  }
}
```

The full form carries `id`, `summary`, `severity` and `affectedPackages` with `name`,
`vulnerableRange` and `firstPatchedVersion`. A malformed entry is an error, not skipped, so a typo
cannot turn into a missed vulnerability.
