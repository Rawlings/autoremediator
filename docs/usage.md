# Usage

Autoremediator fixes vulnerable npm dependencies in a Node.js project. It reads a CVE or GHSA
id, or scanner output, finds the affected installed packages, and applies the safest fix it can.

Requires Node.js 26+. Run it with `npx autoremediator …` or install it globally.

## Quick start

```bash
# Preview a fix for one advisory. Nothing is written.
autoremediator CVE-2021-23337 --dry-run

# Apply it, running your tests afterwards.
autoremediator CVE-2021-23337 --run-tests

# Remediate everything a scanner reported.
autoremediator ./npm-audit.json
autoremediator --audit            # run the package manager's own audit instead of reading a file
```

Run `autoremediator --help` (and `autoremediator <command> --help`) for the complete, current flag
list. This page covers behavior, not every flag.

## How a fix is chosen

For each installed package that is in a vulnerable range, strategies are tried in order, and the
first that works is used:

1. **Version bump** to the lowest safe version (patch, then minor; a major only when the policy sets `allowMajorBumps: true`).
2. **Override** (`overrides` / `resolutions`) when the vulnerable package is transitive.
3. **Generated patch** when no safe version exists or the first two fail. This is the only step
   that uses a language model, and it is off unless you configure one (see below).

Every change is verified (install, plus tests and type checks when enabled) and rolled back if it
fails. A result that could not be fixed is reported as unresolved with a reason; nothing is
reported as fixed that was not.

## Commands

| Command                         | Purpose                                                              |
| ------------------------------- | -------------------------------------------------------------------- |
| `cve <id>` (or just `<id>`)     | Remediate one CVE or GHSA id                                         |
| `scan` (or just `<file>`)       | Remediate from npm/yarn/pnpm/bun audit JSON or SARIF                 |
| `update-outdated`               | Bump every outdated dependency (not security driven)                 |
| `portfolio --targets-file <f>`  | Run across several repositories (see below)                          |
| `diff --base <ref>`             | Scan only dependencies changed since a git ref                       |
| `triage [input]`                | Walk through findings interactively                                  |
| `patches list\|inspect\|validate\|reconcile` | Manage generated `.patch` artifacts                     |
| `reachability --package <n>`    | Check whether a package (or symbol) is imported by project source    |
| `evaluate <package>`            | Pre-install check: known vulnerabilities, exploit signals, safe version |

A portfolio targets file is a JSON array of `{ "cwd": "...", "cveId"?: "...", "inputPath"?: "...",
"label"?: "...", "riskHint"?: { "severity", "exploitSignal", "slaBreached" } }`.

## Scanner inputs

`--format` is `npm-audit`, `yarn-audit`, `sarif` or `auto` (default): `.sarif` files are SARIF, a
JSON-lines file with `auditAdvisory` records is Yarn, anything else is treated as npm audit JSON.
pnpm and bun emit the npm format.

## Patch generation (optional)

Set a model as `<provider>:<model-id>` and install that provider's AI SDK package:

```bash
npm install @ai-sdk/anthropic
export ANTHROPIC_API_KEY=…
autoremediator CVE-2021-23337 --model anthropic:claude-sonnet-5-5   # or AUTOREMEDIATOR_MODEL
```

The provider id maps to `@ai-sdk/<provider>` (anthropic, openai, google, …) and the key is read by
that package from its standard variable. Generated diffs are syntax-checked, gated by a minimum
confidence per risk level (`--patch-confidence-low|medium|high`), applied as `.patch` files, and
verified like any other change. Model-written test code is never executed. Without a model, such
cases are reported as unresolved (`requires-llm-fallback`).

## Output and CI

- `--output-format text|json|sarif` selects the report format; `--summary-file <path>` writes a
  machine-readable summary.
- `--ci` exits with status 1 when any remediation failed, 0 otherwise.
- Each run writes an evidence log to `.autoremediator/evidence/` (`--no-evidence` to disable).
- `--create-change-request` pushes a branch and opens a pull request (GitHub, via the REST API and
  `GITHUB_TOKEN`/`GH_TOKEN`) or merge request (GitLab, via the `glab` CLI). It cannot be combined
  with `--dry-run` or `--preview`.

## Intelligence sources

OSV, the GitHub Advisory Database and NVD supply affected ranges and fixed versions; CISA KEV and
FIRST EPSS supply exploit signals; the npm registry supplies candidate versions. Optional
environment variables: `AUTOREMEDIATOR_NVD_API_KEY`, `GITHUB_TOKEN`, `AUTOREMEDIATOR_EPSS_API`.

`--offline --intelligence-snapshot <file>` skips all intelligence network calls and reads advisories
from a JSON file keyed by CVE id. Each entry is either a full record
(`id`, `summary`, `severity`, `affectedPackages[{ name, vulnerableRange, firstPatchedVersion }]`, …)
or the shorthand `{ "packageName", "vulnerableRange", "firstPatchedVersion", "severity", "epssScore", "cisaKev" }`.
Malformed entries are rejected with an error, not skipped.

## SDK

```ts
import { remediate, remediateFromScan, planRemediation } from "autoremediator";

const report = await remediate("CVE-2021-23337", { cwd: "/path/to/project", dryRun: true });
```

Exports: `remediate`, `planRemediation`, `remediateFromScan`, `remediatePortfolio`,
`updateOutdated`, `scanDelta`, `checkReachability`, `evaluatePackage`, the patch-artifact functions
(`listPatchArtifacts`, `inspectPatchArtifact`, `validatePatchArtifact`, `reconcilePatchArtifacts`),
the job functions (`submitRemediateJob`, `submitScanJob`, `submitPortfolioJob`, `pollJob`), report
helpers (`toCiSummary`, `ciExitCode`, `toSarifOutput`, `toCycloneDxVex`), and the patch-generation
extension points `createLlmPatchGenerator` and `resolveLanguageModel`.

All options are documented on the `RemediateOptions` type
([`packages/core/src/platform/types.ts`](../packages/core/src/platform/types.ts)). To use your own
patch source, pass `patchGenerator` (a `PatchGenerator`: `propose(request) → proposal`) instead of a
model.

Option precedence: explicit options, then the policy file, then defaults. A flag you do not pass
never overrides the policy file.
