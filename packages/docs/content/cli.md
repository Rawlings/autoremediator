# CLI Reference

The CLI is the primary risk-aware automation surface for CI, scheduled workflows, and operator-triggered remediation runs.

It helps teams act on what matters first by combining OSV package intelligence with CISA KEV and FIRST EPSS risk signals, then enforcing policy and evidence controls during execution.

This page documents command behavior, option semantics, and trusted automation patterns.

Related references:

- [Getting Started](getting-started.md)
- [Scanner Inputs](scanner-inputs.md)
- [Policy and Safety](policy-and-safety.md)
- [Integrations](integrations.md)

## Command Modes

Single CVE mode (short form):

```bash
autoremediator CVE-2021-23337
```

Scan input mode (short form):

```bash
autoremediator ./audit.json
autoremediator --input ./scan.json --format auto
```

Equivalent explicit subcommands:

```bash
autoremediator cve CVE-2021-23337
autoremediator scan --input ./audit.json --format npm-audit
autoremediator portfolio --targets-file ./targets.json
autoremediator patches list
autoremediator patches inspect ./patches/lodash+4.17.0.patch
autoremediator patches validate ./patches/lodash+4.17.0.patch
```

When to use which mode:

- use direct CVE mode for urgent, targeted security response
- use scan mode for CI or scheduled automation where multiple findings are expected

## Core Options

| Option | What it controls | Why it matters in automation |
|---|---|---|
| `--cwd <path>` | target project directory | supports centralized runners operating across many repos |
| `--package-manager <npm|pnpm|yarn>` | install/update tool selection | avoids ambiguous lockfile detection in custom pipelines |
| `--dry-run` | simulation-only execution | validates policy and expected actions without file mutation |
| `--preview` | non-mutating remediation preview mode | enables planning flows without write side effects |
| `--run-tests` | post-apply validation | reduces risk of introducing breaking dependency changes |
| `--llm-provider <remote|local>` | patch-generation provider selection | controls determinism, cost, and fallback behavior |
| `--model <name>` | explicit model override | pins runtime model behavior for deterministic environments |
| `--model-personality <analytical|pragmatic|balanced>` | prompt behavior profile | tunes reasoning style without changing tool contracts |
| `--provider-safety-profile <strict|relaxed>` | confidence/safety profile | adjusts confidence thresholds for patch acceptance |
| `--require-consensus-for-high-risk` | high-risk patch consensus gate | requires consensus verification before apply for high-risk patches |
| `--consensus-provider <remote|local>` | high-risk consensus provider override | selects provider used for verifier consensus patch generation |
| `--consensus-model <name>` | high-risk consensus model override | pins verifier model for consensus checks |
| `--patch-confidence-low <value>` | low-risk acceptance threshold (0..1) | tightens or relaxes low-risk patch acceptance |
| `--patch-confidence-medium <value>` | medium-risk acceptance threshold (0..1) | aligns medium-risk acceptance with org policy |
| `--patch-confidence-high <value>` | high-risk acceptance threshold (0..1) | enforces stricter confidence gates for high-risk patches |
| `--dynamic-model-routing` | input-size based remote routing | enables adaptive model routing for large prompts |
| `--dynamic-routing-threshold-chars <count>` | routing threshold | controls when dynamic model routing is activated |
| `--request-id <id>` | request correlation id | links CLI runs to external orchestration traces |
| `--session-id <id>` | session correlation id | groups related remediation runs |
| `--parent-run-id <id>` | parent run linkage | supports hierarchical trace chains in evidence |
| `--idempotency-key <key>` | replay-safe execution key | enables cached resume behavior for repeated jobs |
| `--resume` | reuse cached result for same idempotency key | prevents duplicate remediation work in retried pipelines |
| `--actor <name>` | actor identity metadata | adds provenance context to evidence output |
| `--source <src>` | source system metadata | tags run origin (`cli`, `sdk`, `mcp`, `openapi`, `unknown`) |
| `--direct-dependencies-only` | direct-only remediation constraint | blocks indirect dependency result application |
| `--prefer-version-bump` | bump-only remediation constraint | rejects patch-file outcomes when bump policy is required |
| `--install-mode <deterministic|prefer-offline|standard>` | install command profile for apply and rollback steps | lets operators trade reproducibility vs install flexibility |
| `--install-prefer-offline <true|false>` | force prefer-offline flag behavior | useful for cache-heavy CI or when diagnosing stale cache issues |
| `--enforce-frozen-lockfile <true|false>` | force lockfile-strict install behavior | controls whether install steps must preserve lockfile determinism |
| `--workspace <name>` | workspace/package selector for scoped monorepo remediation | limits install/list/test operations to a target workspace when supported |
| `--create-change-request` | open a native pull request / merge request after remediation | turns successful mutation runs into reviewable branches automatically |
| `--change-request-provider <github|gitlab>` | VCS provider for PR/MR creation | selects the remote API used for branch promotion |
| `--change-request-grouping <all>` | grouping strategy for change requests | currently supports deterministic batched change requests only |
| `--change-request-repository <slug>` | override repo slug used for remote API calls | useful when git remote parsing is not enough |
| `--change-request-base-branch <branch>` | base branch for PR/MR targeting | supports release branches and protected default branches |
| `--change-request-branch-prefix <prefix>` | prefix for generated remediation branches | aligns branch naming with org conventions |
| `--change-request-title-prefix <prefix>` | prefix for generated PR/MR titles | keeps automated reviews recognizable in queue views |
| `--kev-mandatory` | treat CVEs with active CISA KEV status as mandatory regardless of severity | ensures critical actively-exploited CVEs are never filtered by severity thresholds |
| `--epss-threshold <value>` | EPSS probability threshold (0..1) above which a CVE is treated as mandatory | promotes high-probability exploitation CVEs in prioritization without manual triage |
| `--suppressions-file <path>` | path to YAML file containing additional VEX suppression entries | allows context-specific suppression of false positives without modifying the policy file |
| `--sla-check` | compare CVE publication dates against configured SLA windows | surfaces breach records when a CVE has exceeded the configured remediation deadline |
| `--skip-unreachable` | skip remediation for packages not reachable from project source code | reduces noise by excluding packages that cannot be triggered by the running application |
| `--regression-check` | verify patched version is outside the vulnerable range after apply | catches cases where a fix lands within a still-vulnerable range and flags the result |
| `--output-format <text|json|sarif>` | machine-readable or standardized output selection | uses `json` for automation and `sarif` for security tooling integration |

## Scan Mode Options

| Option | What it controls | Why it matters in automation |
|---|---|---|
| `--input <path>` | scanner file path | enables scanner-to-remediation pipelines |
| `--audit` | execute package-manager-native audit command | enables scan workflows without pre-generating an audit file, honors `--workspace` for npm/pnpm, and reports command plus exit-code context on parse failure |
| `--format <auto|npm-audit|yarn-audit|sarif>` | parser adapter selection | improves reliability for mixed scanner ecosystems |
| `--policy <path>` | policy file path | enforces organization-specific safety controls |
| `--evidence` | enables evidence artifact writing | explicit positive control for evidence output |
| `--ci` | non-interactive CI behavior | deterministic summary/exit semantics for gating |
| `--summary-file <path>` | summary artifact output | preserves auditable run metadata for dashboards |
| `--no-evidence` | disables evidence artifact writing | use when evidence must be suppressed for a specific run |

## Update-Outdated Mode

Bumps all outdated npm packages to their latest versions without requiring a CVE ID. Useful for routine maintenance alongside security remediation.

```bash
autoremediator update-outdated
autoremediator update-outdated --include-transitive
autoremediator update-outdated --dry-run --output-format json
autoremediator update-outdated --run-tests --create-change-request --change-request-provider github
```

| Option | What it controls |
|---|---|
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

Portfolio target files are JSON arrays. Each element provides a `cwd` and either `cveId` or `inputPath`/`audit`:

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

Change request execution currently supports batched grouping (`all`) for deterministic branch creation.

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

Use `--dry-run` first when onboarding a new repository or policy file.

## Provider Selection Guidance

| Provider | Recommended use | Considerations |
|---|---|---|
| `local` (deterministic primary path) | regulated or mostly-offline automation, repeatable CI | primary remediation flow avoids remote model calls; no-safe-version patch fallback may require model credentials |
| `remote` | remote model-backed patch generation workflows | requires remote adapter configuration and credentials |

For governance implications, see [Policy and Safety](policy-and-safety.md).

## Automation Examples

Single CVE dry-run preview:

```bash
autoremediator CVE-2021-23337 --dry-run --output-format json

# explicit preview + correlation context
autoremediator cve CVE-2021-23337 --preview --request-id req-42 --session-id nightly-security --output-format json

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

Summary fields to watch:

- `patchCount`: count of patch-file remediations attempted in the scan run
- `strategyCounts`: aggregate counts for `version-bump`, `override`, `patch-file`, and `none`
- `dependencyScopeCounts`: aggregate counts for `direct` and `transitive` remediation outcomes
- `unresolvedByReason`: aggregate counts for machine-readable unresolved causes such as `no-safe-version`, `constraint-blocked`, and `patch-validation-failed`

Patch artifact fields to watch:

- `patchArtifact`: structured metadata for generated patch artifacts and manifest sidecars
- `validationPhases`: phased patch validation details (`diff-format`, `patch-write`, `manifest-write`, `apply`, `install`, `test`, `drift`)

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
