# How it works

A run takes one advisory (or many, from a scanner) and processes every installed package that falls
in a vulnerable range. The flow is deterministic. A language model is used in exactly one place,
the optional [patch fallback](guides/patch-generation.md).

## The run

1. **Look up the advisory.** Affected ranges and fixed versions come from OSV and the GitHub Advisory
   Database; NVD adds severity. CISA KEV and FIRST EPSS add exploit signals. Offline runs read a
   [snapshot](guides/offline.md) instead.
2. **Check policy.** Suppressed advisories are reported but never changed. Exploit signals and
   [SLA](reference/policy-file.md#sla) breaches are recorded.
3. **Find what is affected.** The installed packages are matched against the vulnerable ranges.
4. **Fix each package** with the first strategy that works (below).
5. **Verify and roll back.** Every change is installed and optionally tested and type-checked. If
   anything fails, the project files are restored.
6. **Classify and report.** Each result gets an [outcome](#outcomes) and the run produces a report,
   an SBOM and an evidence file.

## Fix strategies

| Order | Strategy | Used when |
| ----- | -------- | --------- |
| 1 | **Version bump** | A safe version exists. The smallest upgrade is chosen: patch, then minor, then major (which needs `allowMajorBumps: true`). |
| 2 | **Override** | The vulnerable package is transitive. Uses the package manager's own field (`overrides`, `pnpm.overrides`, `resolutions`, or `imports` in `deno.json`). |
| 3 | **Patch** | No safe version exists, or the first two failed. Needs a [configured model](guides/patch-generation.md). |

### Choosing the version

Fixed versions are tried best first: smallest upgrade, then lowest version. Prereleases are skipped
(unless you are already on one), and deprecated releases come last. A candidate is passed over when
it fails the [supply-chain rules](reference/policy-file.md#constraints) (minimum publish age,
install scripts, provenance) or has known advisories of its own, and the next one is tried. If
every fixed version has advisories, the first one is still used, because it removes the advisory
you asked about. The advisory lookup is skipped with `--offline`, and a failed lookup never blocks
a choice. Passed-over versions are named in the result message.

A release cooldown set in your package manager is enforced as well, since installing a younger
version would fail: npm `min-release-age`, pnpm `minimumReleaseAge` (the pnpm 11 default of 24
hours applies when `packageManager` names pnpm 11 or newer), yarn `npmMinimalAgeGate`, and bun
`minimumReleaseAge`. The stricter of that and `supplyChainPolicy.minPublishAgeHours` wins, and
packages the package manager exempts stay exempt.

## Verification

After a change the project is installed again. Installs are not frozen, because the manifest has
just changed; set `enforceFrozenLockfile` to freeze them anyway. Optional steps:

- `--run-tests` runs the project's test script.
- `--typecheck` runs the type checker.
- `--proof-of-fix` runs a Node script you provide before the change (it must fail, showing the
  vulnerability) and after it (it must pass). Put it at `patches/<package>+<version>.test.cjs`, or
  pass `reproductionTest` through the [SDK](reference/sdk.md). `--require-proof-of-fix` rolls back
  a change whose proof fails.
- `autoremediator prove` can write the reproduction script for you: a model proposes it and a sandboxed harness keeps it only if it fails on the vulnerable version and passes on the fixed one ([details](guides/proof-of-fix-generation.md)).
- `--breaking-change-refactor` (experimental) repairs call sites broken by a major upgrade, using
  built-in codemods for `rimraf` and `uuid` only.

Changes made through a [plan](guides/plan-and-apply.md) get a second, independent check: the
[verifier](guides/plan-and-apply.md#verify) looks at the project afterwards and does not take the
apply step's word for it.

## Outcomes

A result is either applied or unresolved. Unresolved results carry an `unresolvedReason`:

| Reason | Meaning |
| ------ | ------- |
| `no-safe-version` | No fixed version exists |
| `major-bump-required` | The only fix is a major upgrade and `allowMajorBumps` is off |
| `constraint-blocked` | A policy constraint forbids the strategy (deny list, `directDependenciesOnly`, `preferVersionBump`) |
| `transitive-dependency` | The package is transitive and could not be bumped directly |
| `override-apply-failed` | The override could not be written |
| `install-failed` | The install after the change failed |
| `validation-failed` | Tests or the type check failed |
| `breaking-change-unresolved` | A major upgrade broke the project and the refactor did not repair it |
| `proof-of-fix-failed` | The proof-of-fix test did not behave as required |
| `requires-llm-fallback` | A patch is needed and no model is configured |
| `patch-generation-failed`, `patch-validation-failed`, `patch-apply-failed`, `patch-confidence-too-low`, `source-fetch-failed` | The patch fallback failed at that step |
| `policy-blocked` | Containment or a required proof of fix held the change back |
| `package-json-not-found` | No `package.json` at the target |
| `transitive-override-unsupported-deno-native` | Deno has no native override for this transitive package |

Every result also gets a **disposition**, evaluated in order. The first match wins:

| Disposition | When |
| ----------- | ---- |
| `escalate` | Install or validation failed; or an exploit signal fired and `escalateOnKev` is on; or the SLA was breached at a listed severity |
| `hold-for-approval` | Patch confidence is below its threshold; or the package is transitive and `holdForTransitive` is on; or applied with confidence below `minConfidenceForAutoApply` |
| `simulate-only` | Unresolved and nothing was applied |
| `auto-apply` | Applied and nothing above matched |

With `containmentMode`, an applied `hold-for-approval` result is rolled back and reported as
`policy-blocked`, so it waits for a human. Urgent `escalate` fixes stay applied.

`escalationGraph` maps an unresolved reason to a follow-up action (`open-issue`, `notify-channel`,
`create-draft-pr`, `hold-branch`, `none`). The action is recorded in the report. Autoremediator does
not open issues or send messages itself; connect the report to whatever should act on it.

## What a run leaves behind

- The edited manifest and lockfile, or `.patch` files in `patches/` with a manifest each.
- An evidence file in `.autoremediator/evidence/` (disable with `--no-evidence`).
- A report in text, JSON or SARIF, and optionally a summary file. See
  [Automation and CI](guides/automation.md).
