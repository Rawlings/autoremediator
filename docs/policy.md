# Policy and safety

Behavior is controlled by a YAML policy file, by default `.github/autoremediator.yml` in the
project (override with `--policy <path>`). Precedence is: explicit options (CLI flags, SDK
options), then the policy file, then built-in defaults. A missing policy file means defaults; an
unreadable or invalid one is an error, not a silent fallback.

## Policy file

```yaml
allowMajorBumps: false          # permit semver-major upgrades
denyPackages: [left-pad, "@acme/*"]   # never touch these (supports * wildcards)
allowPackages: []               # when non-empty, touch only these

constraints:
  directDependenciesOnly: false # ignore transitive dependencies
  preferVersionBump: false      # never fall back to overrides or patches
  installMode: prefer-offline   # standard | prefer-offline | deterministic (cache use only)
  workspace: packages/app       # scope installs to one workspace
  typecheck: false              # run the type checker after each change
  requireProofOfFix: false      # reject changes whose proof-of-fix test fails
  enableBreakingChangeRefactor: false
  supplyChainPolicy:            # applied to candidate versions
    minPublishAgeHours: 72
    blockInstallScripts: true
    requireProvenance: false

patchConfidenceThresholds: { low: 0.65, medium: 0.7, high: 0.8 }

exploitSignalOverride:          # treat these CVEs as mandatory regardless of severity
  kev: { mandatory: true }
  epss: { mandatory: true, threshold: 0.5 }

suppressions:                   # VEX statements; expired entries are ignored
  - cveId: CVE-2024-0001
    justification: not_affected # not_affected | fixed | mitigated | under_investigation
    notes: vulnerable path is disabled
    expiresAt: 2026-12-31

sla: { critical: 24, high: 72, medium: 168, low: 720 }   # hours from publication
skipUnreachable: false

dispositionPolicy:              # see below
  minConfidenceForAutoApply: 0.7
  holdForTransitive: false
  escalateOnKev: true
  escalateOnSlaBreachSeverities: [CRITICAL, HIGH]
containmentMode: false
escalationGraph: { no-safe-version: open-issue }
```

Installs run after the manifest changes, so they are never frozen unless you set
`enforceFrozenLockfile: true` yourself; pnpm and Yarn Berry are explicitly told not to freeze when
`CI` is set.

## Autonomous outcomes

Every result gets a **disposition**, evaluated in this order (first match wins):

1. `escalate`: install or validation failed (`install-failed`, `validation-failed`, `patch-validation-failed`).
2. `escalate`: an exploit signal fired (KEV, or EPSS over its threshold) and `escalateOnKev` is on.
3. `escalate`: the CVE breached its SLA window at a severity listed in `escalateOnSlaBreachSeverities`.
4. `hold-for-approval`: patch confidence was below its threshold.
5. `hold-for-approval`: the package is transitive and `holdForTransitive` is on.
6. `simulate-only`: the result is unresolved and nothing was applied.
7. `hold-for-approval`: applied, but confidence is below `minConfidenceForAutoApply`.
8. `auto-apply`: applied and nothing above matched.

`containmentMode` enforces the human gate: an applied result whose disposition is
`hold-for-approval` is rolled back and reported as unresolved (`policy-blocked`). It never undoes
an `escalate` fix; an exploited or overdue CVE stays fixed while someone is notified.

`escalationGraph` maps an unresolved reason to an intended action (`open-issue`, `notify-channel`,
`create-draft-pr`, `hold-branch`, `none`). Autoremediator records the action in the report and
evidence; it does not open issues or send notifications itself, so wire the report into the
system that should act.

## Other controls

- **Simulation** (`--simulation-mode` with `--dry-run`/`--preview`): attaches the mutations that
  would be made and reasons the plan might be rejected. It is metadata; nothing is written.
- **Campaign mode** (portfolio): orders targets by their `riskHint` (severity, exploit signal, SLA
  breach) and reports a `threatRank` per target.
- **Reachability** (`--skip-unreachable`): skips a CVE when static analysis finds no import of the
  package. This is a heuristic (dynamic requires and config-driven loading are invisible to it), so
  it is used for prioritization and never reported as a VEX `not_affected` claim.
- **Proof of fix** (`--proof-of-fix`): runs a test *you* supply before the change (must fail) and
  after (must pass). Tests written by a model are never executed.
- **Breaking-change refactor** (experimental): when a major upgrade breaks the type check, applies
  built-in codemods (currently `rimraf` and `uuid` only) and reverts them if checks still fail.

## What it guarantees

- Changes are rolled back when installation, tests or validation fail.
- Subprocesses receive a sanitized environment (no `NODE_OPTIONS`, `LD_PRELOAD`, …).
- Generated patches are syntax-checked, confidence-gated and applied as reviewable `.patch` files.
- Dry-run and preview never write, and cannot be combined with change-request creation.
- VEX output (`toCycloneDxVex`) claims `resolved` only when every affected package was fixed, and
  `not_affected` only when every one carries an explicit suppression.
