# CLI Reference

The CLI is the primary risk-aware automation surface for CI, scheduled workflows, and operator-triggered remediation runs.

It helps teams act on what matters first by combining OSV package intelligence with CISA KEV and FIRST EPSS risk signals, then enforcing policy and evidence controls during execution.

This page documents command behavior, option semantics, and trusted automation patterns.

Related references:

- [Getting Started](getting-started.md)
- [Scanner Inputs](scanner-inputs.md)
- [Policy and Safety](policy-and-safety.md)
- [Integrations](integrations.md)

## Autonomous Operator Flags

The CLI exposes autonomous operator controls in addition to base remediation behavior:

- `--simulation-mode` for planned mutations and rebuttal findings in dry-run/preview flows
- `--containment-mode` for blocking applied escalation outcomes
- `--min-confidence-for-auto-apply`, `--hold-for-transitive`, and `--escalate-on-kev` for `dispositionPolicy`
- `--campaign-mode` for portfolio target risk ranking

## Command Modes

Single CVE or GHSA mode (short form):

```bash
autoremediator CVE-2021-23337
autoremediator GHSA-36p3-wjmg-h94x
```

Scan input mode (short form):

```bash
autoremediator ./audit.json
autoremediator --input ./scan.json --format auto
```

Equivalent explicit subcommands:

```bash
autoremediator cve CVE-2021-23337
autoremediator cve GHSA-36p3-wjmg-h94x
autoremediator scan --input ./audit.json --format npm-audit
autoremediator diff --base origin/main
autoremediator portfolio --targets-file ./targets.json
autoremediator reachability --package lodash --symbol merge
autoremediator evaluate express@4.18.2
autoremediator patches list
autoremediator patches inspect ./patches/lodash+4.17.0.patch
autoremediator patches validate ./patches/lodash+4.17.0.patch
autoremediator patches reconcile [--auto-apply]
autoremediator triage [./audit.json]
```

When to use which mode:

- use direct CVE / GHSA mode for urgent, targeted security response
- use scan mode for CI or scheduled automation where multiple findings are expected
- use interactive triage (`autoremediator triage` or `-i, --interactive`) for developer-assisted step-by-step remediation
- use git delta diff mode (`autoremediator diff`) to audit lockfile changes introduced in pull requests or branches

## Core Options

| Option                                      | What it controls                                                            | Why it matters in automation                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--cwd <path>`                              | target project directory                                                    | supports centralized runners operating across many repos                                                              |
| `--package-manager <manager>`               | tool selection: `npm`, `pnpm`, `yarn`, `bun`, or `deno`                     | avoids ambiguous lockfile detection in custom pipelines                                                               |
| `--dry-run`                                 | simulation-only execution                                                   | validates policy and expected actions without file mutation                                                           |
| `--preview`                                 | non-mutating remediation preview mode                                       | enables planning flows without write side effects                                                                     |
| `--simulation-mode`                         | deterministic simulation metadata                                           | adds planned mutation and rebuttal summaries to dry-run or preview results                                            |
| `--run-tests`                               | post-apply validation                                                       | reduces risk of introducing breaking dependency changes                                                               |
| `--typecheck`                               | post-apply typecheck gate (e.g. `tsc --noEmit` or `deno check`)             | prevents type regressions and compilation breaks from landing in remediation branches                                 |
| `-i, --interactive`                         | interactive triage workflow                                                 | steps through findings one-by-one allowing developers to apply, skip, or suppress                                     |
| `--llm-provider <provider>`                 | patch-generation provider: `remote` or `local`                              | controls determinism, cost, and fallback behavior                                                                     |
| `--model <name>`                            | explicit model override                                                     | pins runtime model behavior for deterministic environments                                                            |
| `--model-personality <profile>`             | prompt behavior profile: `analytical`, `pragmatic`, or `balanced`           | tunes reasoning style without changing tool contracts                                                                 |
| `--provider-safety-profile <profile>`       | safety profile: `strict` or `relaxed`                                       | adjusts confidence thresholds for patch acceptance                                                                    |
| `--require-consensus-for-high-risk`         | high-risk patch consensus gate                                              | requires consensus verification before apply for high-risk patches                                                    |
| `--consensus-provider <provider>`           | high-risk consensus provider override: `remote` or `local`                  | selects provider used for verifier consensus patch generation                                                         |
| `--consensus-model <name>`                  | high-risk consensus model override                                          | pins verifier model for consensus checks                                                                              |
| `--patch-confidence-low <value>`            | low-risk acceptance threshold (0..1)                                        | tightens or relaxes low-risk patch acceptance                                                                         |
| `--patch-confidence-medium <value>`         | medium-risk acceptance threshold (0..1)                                     | aligns medium-risk acceptance with org policy                                                                         |
| `--patch-confidence-high <value>`           | high-risk acceptance threshold (0..1)                                       | enforces stricter confidence gates for high-risk patches                                                              |
| `--dynamic-model-routing`                   | input-size based remote routing                                             | enables adaptive model routing for large prompts                                                                      |
| `--dynamic-routing-threshold-chars <count>` | routing threshold                                                           | controls when dynamic model routing is activated                                                                      |
| `--request-id <id>`                         | request correlation id                                                      | links CLI runs to external orchestration traces                                                                       |
| `--session-id <id>`                         | session correlation id                                                      | groups related remediation runs                                                                                       |
| `--parent-run-id <id>`                      | parent run linkage                                                          | supports hierarchical trace chains in evidence                                                                        |
| `--idempotency-key <key>`                   | replay-safe execution key                                                   | enables cached resume behavior for repeated jobs                                                                      |
| `--resume`                                  | reuse cached result for same idempotency key                                | prevents duplicate remediation work in retried pipelines                                                              |
| `--actor <name>`                            | actor identity metadata                                                     | adds provenance context to evidence output                                                                            |
| `--source <src>`                            | source system metadata                                                      | tags run origin (`cli`, `sdk`, `mcp`, `openapi`, `unknown`)                                                           |
| `--direct-dependencies-only`                | direct-only remediation constraint                                          | blocks indirect dependency result application                                                                         |
| `--prefer-version-bump`                     | bump-only remediation constraint                                            | rejects patch-file outcomes when bump policy is required                                                              |
| `--min-confidence-for-auto-apply <value>`   | minimum confidence for automatic apply classification                       | moves lower-confidence successful results into hold-for-approval instead of auto-apply                                |
| `--hold-for-transitive`                     | require approval for transitive dependency remediations                     | keeps override- or transitive-targeted outcomes out of auto-apply flows                                               |
| `--escalate-on-kev`                         | escalate when KEV exploit signal is active                                  | prioritizes actively exploited CVEs for operator handling                                                             |
| `--install-mode <mode>`                     | install command profile: `deterministic`, `prefer-offline`, or `standard`   | lets operators balance reproducibility vs install flexibility                                                         |
| `--install-prefer-offline <bool>`           | force prefer-offline flag behavior (`true`/`false`)                         | useful for cache-heavy CI or when diagnosing stale cache issues                                                       |
| `--enforce-frozen-lockfile <bool>`          | force lockfile-strict install behavior (`true`/`false`)                     | controls whether install steps must preserve lockfile determinism                                                     |
| `--workspace <name>`                        | workspace/package selector for scoped monorepo remediation                  | limits install/list/test operations to a target workspace when supported                                              |
| `--create-change-request`                   | open a native pull request / merge request after remediation                | turns successful mutation runs into reviewable branches automatically                                                 |
| `--change-request-provider <provider>`      | VCS provider for PR/MR creation: `github` or `gitlab`                       | selects the remote API used for branch promotion                                                                      |
| `--change-request-grouping <strategy>`      | grouping strategy: `all`, `per-cve`, `per-package`, or `by-severity`        | creates separate reviewable branches/PRs per CVE, per package, by severity, or batched                                |
| `--change-request-repository <slug>`        | override repo slug used for remote API calls                                | useful when git remote parsing is not enough                                                                          |
| `--change-request-base-branch <branch>`     | base branch for PR/MR targeting                                             | supports release branches and protected default branches                                                              |
| `--change-request-branch-prefix <prefix>`   | prefix for generated remediation branches                                   | aligns branch naming with org conventions                                                                             |
| `--change-request-title-prefix <prefix>`    | prefix for generated PR/MR titles                                           | keeps automated reviews recognizable in queue views                                                                   |
| `--kev-mandatory`                           | treat CVEs with active CISA KEV status as mandatory regardless of severity  | ensures critical actively-exploited CVEs are never filtered by severity thresholds                                    |
| `--epss-threshold <value>`                  | EPSS probability threshold (0..1) above which a CVE is treated as mandatory | promotes high-probability exploitation CVEs in prioritization without manual triage                                   |
| `--suppressions-file <path>`                | path to YAML file containing additional VEX suppression entries             | allows context-specific suppression of false positives without modifying the policy file                              |
| `--sla-check`                               | compare CVE publication dates against configured SLA windows                | surfaces breach records when a CVE has exceeded the configured remediation deadline                                   |
| `--skip-unreachable`                        | skip remediation for packages not reachable from project source code        | reduces noise by excluding packages that cannot be triggered by the running application                               |
| `--regression-check`                        | verify patched version is outside the vulnerable range after apply          | catches cases where a fix lands within a still-vulnerable range and flags the result                                  |
| `--output-format <format>`                  | output format: `text`, `json`, `sarif`, or `cyclonedx-vex`                  | uses `json` for automation, `sarif` for security tooling, and `cyclonedx-vex` for CycloneDX 1.5 VEX export            |
| `--containment-mode`                        | block applied remediation outcomes when disposition is `escalate`           | prevents autonomous apply on escalation cases and records containment in evidence (`unresolvedReason=policy-blocked`) |
| `--proof-of-fix <path>`                     | synthesized exploit reproduction test script                                | executes dual-stage proof-of-fix verification (negative test pre-mutation, positive test post-mutation)               |
| `--require-proof-of-fix`                    | mandate exploit reproduction before applying patch                          | rejects patches when exploit reproduction script fails to trigger failure on unpatched baseline                       |
| `--breaking-change-refactor`                | automatic AST-guided consumer call-site refactoring                         | attempts automated codemod repair on consumer call-sites when version bumps introduce breaking API shifts             |
| `--offline`                                 | skip all external CVE intelligence network calls                            | enables air-gap and sovereign deployment scenarios where internet access is unavailable or restricted                 |
| `--intelligence-snapshot <path>`            | load pre-fetched CVE intelligence from a local JSON file                    | pair with `--offline` to supply CVE data in network-restricted environments                                           |

## Scan Mode Options

| Option                  | What it controls                                              | Why it matters in automation                                                                                                                                |
| ----------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--input <path>`        | scanner file path                                             | enables scanner-to-remediation pipelines                                                                                                                    |
| `--audit`               | execute package-manager-native audit command                  | enables scan workflows without pre-generating an audit file, honors `--workspace` for npm/pnpm, and reports command plus exit-code context on parse failure |
| `--format <format>`     | parser adapter: `auto`, `npm-audit`, `yarn-audit`, or `sarif` | improves reliability for mixed scanner ecosystems                                                                                                           |
| `--policy <path>`       | policy file path                                              | enforces organization-specific safety controls                                                                                                              |
| `--evidence`            | enables evidence artifact writing                             | explicit positive control for evidence output                                                                                                               |
| `--ci`                  | non-interactive CI behavior                                   | deterministic summary/exit semantics for gating                                                                                                             |
| `--summary-file <path>` | summary artifact output                                       | preserves auditable run metadata for dashboards                                                                                                             |
| `--no-evidence`         | disables evidence artifact writing                            | use when evidence must be suppressed for a specific run                                                                                                     |

## Update-Outdated Mode

Bumps all outdated npm packages to their latest versions without requiring a CVE ID. Useful for routine maintenance alongside security remediation.

```bash
autoremediator update-outdated
autoremediator update-outdated --include-transitive
autoremediator update-outdated --dry-run --output-format json
autoremediator update-outdated --run-tests --create-change-request --change-request-provider github
```

| Option                 | What it controls                                                             |
| ---------------------- | ---------------------------------------------------------------------------- |
| `--include-transitive` | Include transitive dependencies in the outdated check (default: direct only) |

Packages where only a major version bump is available are skipped when `allowMajorBumps: false` (the default). They appear in `skippedCount` in the report, not `failedCount`.

## Patch Lifecycle Commands

Patch fallback now emits durable patch artifacts that can be managed separately from a remediation run.

Available commands:

- `autoremediator patches list`
- `autoremediator patches inspect <patch-file>`
- `autoremediator patches validate <patch-file>`
- `autoremediator portfolio --targets-file ./targets.json`
- `autoremediator update-outdated`

Portfolio target files are JSON arrays. Each element provides a `cwd` and either `cveId` or `inputPath`/`audit`.

Add `--campaign-mode` to enable risk-ranked execution. Targets with a `riskHint` field (providing `severity`, `exploitSignal`, and/or `slaBreached`) are scored and executed highest-risk first. Each result in the portfolio report includes a `threatRank` field reflecting its position in the ranked order:

```bash
autoremediator portfolio --targets-file ./targets.json --campaign-mode
```

```json
[
  { "cwd": "./services/api", "cveId": "CVE-2021-23337" },
  { "cwd": "./services/web", "inputPath": "./audit.json", "format": "npm-audit" }
]
```

Examples:

```bash
autoremediator patches list --patches-dir ./patches --output-format json
autoremediator patches inspect ./patches/lodash+4.17.0.patch --output-format json
autoremediator patches validate ./patches/lodash+4.17.0.patch --package-manager pnpm --output-format json
```

What each command is for:

- `list`: enumerate `.patch` artifacts and manifest metadata
- `inspect`: read patch metadata, file scope, and diff-format validity
- `validate`: verify manifest presence, diff validity, and dependency-version drift against current inventory
- `reconcile`: inspect active patches against upstream registries and automatically upgrade packages and retire `.patch` files when official fixes are published

Reconcile examples:

```bash
# Check if any active patches now have official upstream fixes available
autoremediator patches reconcile

# Automatically upgrade packages, clean patch configurations, and verify tests
autoremediator patches reconcile --auto-apply --run-tests
```

### Automated Reproduction Test Synthesis

When synthesizing patches for vulnerabilities without safe upstream versions, Autoremediator instructs the synthesis engine to generate a standalone reproduction/regression test script (`reproductionTest`) alongside the patch diff:

- Saved to disk as `patches/<package>+<version>.test.cjs`.
- Executed in an isolated subprocess during the post-apply validation sequence.
- Validates that the targeted exploit payload or vulnerability condition is neutralized before the patch is accepted.
- Associated metadata (`reproductionTest` and `reproductionTestPath`) is persisted in the `.patch.json` manifest sidecar for continuous regression auditing.

## Interactive Developer Triage

For assisted remediation in local development workflows, run `autoremediator triage` or use `-i` / `--interactive`:

```bash
# Interactively triage findings from package manager audit
autoremediator triage

# Interactively triage findings from a scanner JSON file
autoremediator triage ./audit.json

# Launch interactive mode with automatic test validation on apply
autoremediator --input ./audit.json -i --run-tests
```

During triage, each unique finding is displayed in the terminal with:

- Target vulnerability identifier (CVE or GHSA)
- Affected package name and severity
- Safe upstream upgrade version (when available)
- EPSS score and CISA KEV exploitation signals

Interactive keyboard actions:

- `[a]pply`: runs the full remediation pipeline for the finding immediately (attempting version-bump, override, or patch)
- `[s]kip`: skips the finding and proceeds to the next vulnerability
- `[x] suppress`: marks the CVE as suppressed / VEX excluded
- `[q]uit`: exits the triage session and displays an aggregate summary

## Direct GHSA Identifier Remediation

In addition to standard CVE identifiers (`CVE-YYYY-NNNNN`), Autoremediator natively supports GitHub Security Advisory identifiers (`GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}`):

```bash
autoremediator GHSA-36p3-wjmg-h94x
autoremediator cve GHSA-36p3-wjmg-h94x --dry-run
```

Direct GHSA mode queries the GitHub Advisory API directly, resolves affected package ranges and safe versions, and executes the remediation pipeline identically to CVE workflows.

## Post-Apply TypeCheck Gate (`--typecheck`)

When remediating dependencies in TypeScript or strongly-typed Node.js projects, version upgrades can introduce type errors even if unit tests pass.

Passing `--typecheck` ensures that a type verification command is executed after every dependency mutation:

```bash
autoremediator CVE-2021-23337 --typecheck
autoremediator --input ./audit.json --typecheck --run-tests
```

How it works:

1. Detects `scripts.typecheck` in the target `package.json` (e.g. `npm run typecheck` or `pnpm typecheck`).
2. If no script is declared, falls back to `tsc --noEmit` (or `deno check` in Deno environments).
3. If typechecking fails, the change is immediately rolled back, and the finding is recorded as `unresolvedReason: "validation-failed"`.

## Git-Aware Delta Vulnerability Scanning (`autoremediator diff`)

Instead of analyzing the entire project dependency tree, delta scanning audits only dependencies that were added, upgraded, downgraded, or removed across Git revisions or within uncommitted working tree changes.

```bash
# Compare current working tree against HEAD
autoremediator diff

# Compare against a base branch (e.g. in PR CI workflows)
autoremediator diff --base origin/main

# Output JSON report and enforce CI exit codes
autoremediator diff --base origin/main --ci --output-format json
```

How it works:

- Computes lockfile diffs between the target base ref and current working tree across npm (`package-lock.json` v1, v2, v3), pnpm (`pnpm-lock.yaml` v5, v6, v9), and Yarn (`yarn.lock` v1).
- Traces both direct and transitive dependency changes (`dependencyType: "direct" | "transitive"`).
- Cross-references newly added or modified package versions against OSV and GitHub Advisory databases.
- Computes a net risk verdict:
  - `improved`: net reduction in vulnerability exposure
  - `neutral`: dependency changes introduced no new vulnerabilities
  - `degraded`: new vulnerabilities were introduced by lockfile changes
- When `--ci` is enabled, exits with code `1` if `netRiskVerdict === "degraded"` and `0` otherwise.

## Monorepo Workspace Scoping (`--workspace`)

Autoremediator natively understands monorepo topologies across pnpm (`pnpm-workspace.yaml`), npm/yarn (`workspaces` in root `package.json`), and Lerna (`lerna.json`).

```bash
# Scope remediation to a specific workspace package
autoremediator CVE-2021-23337 --workspace @apps/web

# Run audit remediation within a workspace package
autoremediator --audit --workspace @services/api --ci
```

Key behaviors:

- **Topology Resolution**: Recursively resolves all declared member packages in the monorepo root.
- **Member Declaration Matching**: In scan or multi-vulnerability modes, inventory analysis inspects member `package.json` manifests to locate the exact workspace package declaring the dependency, preventing dependencies declared in member packages from being misclassified as unresolvable transitive dependencies.
- **Targeted Package Manager Execution**: Bumps and installs are automatically targeted to the declaring package member using package manager native filters (e.g., `pnpm --filter <pkg>`, `npm --workspace <pkg>`, `yarn workspace <pkg>`), preserving workspace isolation.

## What `--ci` Changes

`--ci` is designed for deterministic, non-interactive environments:

- stable summary semantics suitable for pipeline gating
- explicit unresolved/failure signaling
- no interactive prompts

Pairing recommendations:

- `--ci --summary-file ./summary.json` for machine-consumed gate results
- `--ci --dry-run` for pre-merge guardrails that do not mutate dependencies

## Review-Ready Automation

When change-request flags are provided on mutating runs, autoremediator can:

- create remediation branches locally
- push them to GitHub or GitLab remotes
- open pull requests / merge requests when the corresponding API token is available

Grouping strategies configured via `--change-request-grouping`:

- `all` (default): all remediated vulnerabilities are batched into a single branch and PR/MR
- `per-cve`: creates an isolated branch and PR/MR for each remediated vulnerability
- `per-package`: groups remediated vulnerabilities by affected package into separate PRs/MRs
- `by-severity`: groups remediated vulnerabilities by severity tier (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`)

Native pull request and merge request creation shells out through `gh` for GitHub and `glab` for GitLab, so the matching CLI must be available in the execution environment when `--create-change-request` is enabled.

## Dependency path diagnostics and override targeting

During remediation analysis, autoremediator uses package-manager-native dependency path diagnostics where available:

- `npm explain`
- `pnpm why`
- `yarn why`

This helps surface why a vulnerable package is present before choosing a remediation strategy.

For transitive remediation, override application can target manager-native selector keys, including nested and scoped selectors, so override results stay aligned with how each package manager models dependency edges.

## Dry-Run Semantics

When `--dry-run` is enabled:

- dependency graph analysis and decision logic still run
- policy checks still apply
- file mutations must not occur
- unresolved reasons still surface for operator action

When `--simulation-mode` is enabled alongside `--dry-run` or `--preview`:

- each result includes `simulation.plannedMutations` and `simulation.rebuttalFindings`
- remediation, scan, and CI summaries include `simulationSummary`
- mutating runs are rejected; use `planRemediation` or add `--dry-run`/`--preview`

Use `--dry-run` first when onboarding a new repository or policy file.

## Provider Selection Guidance

| Provider                             | Recommended use                                       | Considerations                                                                                                   |
| ------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `local` (deterministic primary path) | regulated or mostly-offline automation, repeatable CI | primary remediation flow avoids remote model calls; no-safe-version patch fallback may require model credentials |
| `remote`                             | remote model-backed patch generation workflows        | requires remote adapter configuration and credentials                                                            |

For governance implications, see [Policy and Safety](policy-and-safety.md).

## Automation Examples

Single CVE dry-run preview:

```bash
autoremediator CVE-2021-23337 --dry-run --output-format json
autoremediator CVE-2021-23337 --dry-run --simulation-mode --output-format json

# explicit preview + correlation context
autoremediator cve CVE-2021-23337 --preview --simulation-mode --request-id req-42 --session-id nightly-security --output-format json

# resumable + constrained run
autoremediator CVE-2021-23337 --idempotency-key nightly-cve-2021-23337 --resume --direct-dependencies-only --prefer-version-bump --actor sec-bot --source cli --output-format json
```

CI scanner gate with summary artifact:

```bash
autoremediator scan --input ./audit.json --format auto --ci --summary-file ./summary.json
```

Policy-controlled remediation with validation:

```bash
autoremediator CVE-2021-23337 --policy ./.github/autoremediator.yml --run-tests
```

Deterministic mode run:

```bash
autoremediator ./audit.json --format auto --llm-provider local --ci
```

Successful version-bump and override remediations also run a best-effort package-manager dedupe pass after apply and validation to reduce duplicate transitive installs when the package manager supports it.

## CI Exit Behavior

Current CI exit semantics:

- `0`: no failed remediations
- `1`: one or more failed remediations

Use summary data to distinguish fully remediated, partially remediated, and unresolved outcomes in downstream automation.

Summary payloads include `escalationCounts` to expose intended escalation actions for unresolved outcomes without executing external notifications or ticketing actions.

Summary fields to watch:

- `patchCount`: count of patch-file remediations attempted in the scan run
- `strategyCounts`: aggregate counts for `version-bump`, `override`, `patch-file`, and `none`
- `dependencyScopeCounts`: aggregate counts for `direct` and `transitive` remediation outcomes
- `dispositionCounts`: aggregate counts for `auto-apply`, `simulate-only`, `hold-for-approval`, and `escalate`
- `unresolvedByReason`: aggregate counts for machine-readable unresolved causes such as `no-safe-version`, `constraint-blocked`, and `patch-validation-failed`
- `simulationSummary`: aggregate planned-mutation and rebuttal counts for dry-run or preview simulation flows
- `slaBreachSummary`: structured breach list with `breachCount`, per-breach `cveId`, `severity`, `hoursOverdue`, `deadlineAt`, and `recommendedAction` — present when `--sla-check` is enabled and at least one CVE is overdue

## CI Text Output

In text output mode (`--output-format text`, the default), the scan runner emits additional lines when relevant:

**Transitive remediations notice** — emitted when one or more transitive dependency remediations succeeded:

```
  Transitive remediations: 2 (fixed without requiring upstream patch)
```

**Patch-generated block** — emitted when at least one `patch-file` result exists. Shows count, average patch confidence, and the CVE-affected version range for each unique `vulnerableRange` across patch-file results:

```
Patch-generated (no upstream fix): 1
  Avg patch confidence: 0.87
  Vulnerable range: >=1.0.0 <1.2.6
```

**SLA breach block** — emitted when `slaBreachSummary` is populated (requires `--sla-check`):

```
SLA breaches: 2 CVE(s) overdue
  CVE-2021-23337: HIGH, 48h overdue → open-issue
  CVE-2022-31129: CRITICAL, 12h overdue → create-draft-pr
```

Patch artifact fields to watch:

- `patchArtifact`: structured metadata for generated patch artifacts and manifest sidecars
- `validationPhases`: phased patch validation details (`diff-format`, `patch-write`, `manifest-write`, `apply`, `install`, `test`, `reproduction-test`, `drift`)

## Troubleshooting

- output seems incomplete:
  - add `--output-format json` for structured parsing
  - write `--summary-file` and inspect unresolved details
- scan parsing issues:
  - specify `--format` explicitly instead of `auto`
  - when using `--audit`, inspect the reported command and exit-code context first
  - validate scanner file shape with [Scanner Inputs](scanner-inputs.md)
- remediations blocked unexpectedly:
  - verify `--policy` path and contents
  - check package allow/deny controls in [Policy and Safety](policy-and-safety.md)

## Related Docs

- [Getting Started](getting-started.md)
- [Policy and Safety](policy-and-safety.md)
- [Integrations](integrations.md)
- [Agent Ecosystems](agent-ecosystems.md)
