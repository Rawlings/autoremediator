# Policy file

A YAML file that sets the rules for a project. It is read from `.github/autoremediator.yml`, or from
the path given to `--policy`. A missing default file means built-in defaults. An explicit path that
does not exist, invalid YAML, unknown keys and bad values are errors.

Explicit options override the policy file, which overrides defaults. The [GitHub
App](../integrations/github-app.md) reads a related file; see that page for its extra keys.

```yaml
allowMajorBumps: false
denyPackages: [left-pad, "@acme/*"]
allowPackages: []

constraints:
  directDependenciesOnly: false
  preferVersionBump: false
  installMode: standard
  workspace: packages/app
  typecheck: true
  supplyChainPolicy:
    minPublishAgeHours: 72
    blockInstallScripts: true

patchConfidenceThresholds: { low: 0.65, medium: 0.7, high: 0.8 }

exploitSignalOverride:
  kev: { mandatory: true }
  epss: { mandatory: true, threshold: 0.5 }

suppressions:
  - cveId: CVE-2024-0001
    justification: not_affected
    notes: Vulnerable path is disabled
    expiresAt: 2026-12-31

sla: { critical: 24, high: 72, medium: 168, low: 720 }
skipUnreachable: false

dispositionPolicy:
  minConfidenceForAutoApply: 0.7
  holdForTransitive: false
  escalateOnKev: true
  escalateOnSlaBreachSeverities: [CRITICAL, HIGH]
containmentMode: false
escalationGraph: { no-safe-version: open-issue }
```

## Autonomy and recipes

| Key | Meaning |
| --- | ------- |
| `autonomy` | `ceiling` (`L0`..`L4`, required), `minVerifiedRuns` (5), `window` (20), `minSuccessRate` (0.9), `cooldownDays` (7), `requireTestCoverage` (true). Caps how much a repository may do on its own; the earned level comes from its [track record](../guides/earned-autonomy.md). Only the policy file can set it |
| `trustMaintainerVex` | `true` lets a `not_affected` [VEX statement shipped by an installed package](../guides/maintainer-vex.md) suppress remediation of the dependency it covers (`suppressedBy.source: maintainer-vex`). Default `false`: shown as evidence only. Policy file only |
| `installScripts` | `none` (default) or `all`. Installs this tool starts skip dependency lifecycle scripts (`--ignore-scripts`; `YARN_ENABLE_SCRIPTS=0` for Yarn Berry), because the version it just picked is the least trusted code on the machine. `all` runs them again; Yarn Berry also needs `YARN_ENABLE_SCRIPTS=1` in the environment. Policy file only |
| `freshness` | `maxMajorsBehind`, `maxMinorsBehind` (on the latest major), `maxAgeDays`, `ignore` (name, `@scope/*`, `prefix*`). At least one limit is required. Drives [freshness](../guides/freshness.md); without the key nothing is planned |
| `recipes.packages` | npm package names whose `recipes/` are trusted as [recipe](../guides/recipes.md) sources for any package |

## Packages

| Key | Meaning |
| --- | ------- |
| `allowMajorBumps` | Permit semver-major upgrades. Default `false` |
| `denyPackages` | Never change these. `*` wildcards are supported |
| `allowPackages` | When non-empty, change only these |

## Constraints

| Key | Meaning |
| --- | ------- |
| `directDependenciesOnly` | Ignore transitive packages |
| `preferVersionBump` | Forbid overrides and patches |
| `installMode` | `standard`, `prefer-offline` or `deterministic` (cache behavior only) |
| `installPreferOffline`, `enforceFrozenLockfile` | Override those install flags |
| `workspace` | Scope installs to one workspace package |
| `typecheck` | Run the type checker after each change |
| `requireProofOfFix` | Roll back changes whose proof of fix fails |
| `enableBreakingChangeRefactor` | Experimental codemods |
| `supplyChainPolicy.minPublishAgeHours` | Skip versions published more recently than this (the package manager's own [cooldown](../how-it-works.md#choosing-the-version) is applied too, whichever is longer) |
| `supplyChainPolicy.blockInstallScripts` | Skip versions that define install scripts |
| `supplyChainPolicy.requireProvenance` | Require a provenance attestation |

## Exploit signals

`exploitSignalOverride` makes a CVE mandatory regardless of severity when CISA KEV lists it, or when
its EPSS score is above `threshold`. A mandatory CVE also sets `exploitSignalTriggered` on the
report, which feeds [escalation](../how-it-works.md#outcomes).

## Suppressions

Records that an advisory does not need action, in VEX terms. `justification` is `not_affected`,
`fixed`, `mitigated` or `under_investigation`. Entries past `expiresAt` are ignored. A suppressed
advisory changes nothing, but the report lists each installed copy it covers as a suppressed
result, which drives `not_affected` in VEX output and `suppressed` in the SBOM. More entries can be merged
from a file with `--suppressions-file`: a YAML file with a top-level `suppressions` list of the same
entries. A missing file or an invalid entry is an error.

## SLA

Hours from publication to the deadline, per severity. With `--sla-check` (or `slaCheck`), CVEs past
their deadline are listed as `slaBreaches` in the report. A breach at a severity in
`escalateOnSlaBreachSeverities` escalates the result.

## Outcomes

`dispositionPolicy`, `containmentMode` and `escalationGraph` configure how results are classified
and escalated. See [Outcomes](../how-it-works.md#outcomes). Without an entry, `escalationGraph`
defaults are `no-safe-version`, `patch-validation-failed` and `patch-confidence-too-low` →
`open-issue`; `source-fetch-failed` and `patch-generation-failed` → `notify-channel`;
`validation-failed` → `create-draft-pr`.

`patchConfidenceThresholds` and `skipUnreachable` work as their [CLI flags](cli.md).
