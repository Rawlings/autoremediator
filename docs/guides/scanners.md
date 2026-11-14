# Scanners and inputs

Autoremediator accepts an advisory id, a scanner report, or a set of changed dependencies.

## A single advisory

```bash
autoremediator CVE-2021-23337
autoremediator GHSA-35jh-r3h4-6jhm
```

`cve <id>` is the explicit form; a bare id works too.

## Scanner output

```bash
autoremediator ./npm-audit.json           # read a report
autoremediator scan --input ./report.sarif
autoremediator --audit                    # run the project's own audit command
```

`--format` selects the parser. The default, `auto`, treats `.sarif` files as SARIF and a JSON-lines
file with `auditAdvisory` records as Yarn, and everything else as npm audit JSON. pnpm and Bun emit
the npm format.

| Format | Produced by |
| ------ | ----------- |
| `npm-audit` | `npm audit --json`, `pnpm audit --json`, `bun audit --json` |
| `yarn-audit` | `yarn audit --json` |
| `sarif` | Any SARIF 2.1.0 producer |

Findings are deduplicated by id, so an advisory reported twice is fixed once. An advisory with a CVE
id is handled under it; one with only a GHSA id is handled under the GHSA id.

## Only what changed

`diff` scans only the dependencies that differ from a git reference, which keeps pull request checks
fast.

```bash
autoremediator diff --base origin/main --ci
```

It compares the dependency manifests at the base and in the working tree, and reports
vulnerabilities in the added or upgraded packages.

## Interactive triage

```bash
autoremediator triage ./npm-audit.json
```

Walks through the findings one at a time so you choose what to fix. `-i` on other commands starts
the same flow.

## Many repositories

`portfolio` runs a single advisory or a scan across several projects and aggregates the outcome.

```bash
autoremediator portfolio --targets-file ./targets.json --campaign-mode
```

```json
[
  { "cwd": "/work/api", "cveId": "CVE-2021-23337" },
  { "cwd": "/work/web", "inputPath": "/work/web/npm-audit.json", "label": "web",
    "riskHint": { "severity": "CRITICAL", "exploitSignal": true, "slaBreached": false } }
]
```

Each target needs `cwd` and exactly one of `cveId`, `inputPath` or `audit: true`. `--campaign-mode`
orders targets by `riskHint` and reports a `threatRank` for each.

## Outdated dependencies

`update-outdated` is not tied to a vulnerability: it bumps every outdated dependency, verifies, and
rolls back what fails. Add `--include-transitive` to cover transitive packages.

## Checking before you install

```bash
autoremediator evaluate express@4.18.2
autoremediator reachability --package lodash --symbol template
```

`evaluate` reports known vulnerabilities, exploit signals and a safe version for a package you have
not installed. `reachability` checks whether project source imports a package or symbol. It is a
static scan; see [Safety](../safety.md#limits).
