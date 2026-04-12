# Getting Started

Autoremediator is a risk-aware, agentic remediation system for Node.js dependency CVEs.

It combines OSV package intelligence, CISA KEV known-exploited signals, and FIRST EPSS exploit probability scores so teams can prioritize what is more likely to be exploited instead of treating every finding equally.

It supports two primary execution paths:

- direct CVE remediation (for urgent, targeted fixes)
- scanner-driven remediation (for CI and recurring automation)

This page explains what to run, why you would run it, and how to interpret risk-aware results with safety and evidence controls.

Related references:

- [CLI Reference](cli.md)
- [Scanner Inputs](scanner-inputs.md)
- [Policy and Safety](policy-and-safety.md)
- [API and SDK](api-sdk.md)
- [Integrations](integrations.md)

## What You Need

- Node.js 22+
- one package manager in your target project (`pnpm`, `npm`, or `yarn`)
- a repository with lockfile and dependency manifest
- optional model credentials for patch generation fallback:
	- `AUTOREMEDIATOR_REMOTE_API_KEY`

If you use `--llm-provider local`, API keys are not required for the deterministic primary flow; patch fallback for no-safe-version cases may still require remote model credentials.

## Install

Try without installing:

```bash
npx autoremediator --help
```

Global install is useful for operator workstations:

```bash
pnpm add -g autoremediator
# or
npm install -g autoremediator
# or
yarn global add autoremediator
```

Project-local install is recommended for CI reproducibility:

```bash
pnpm add -D autoremediator
pnpm exec autoremediator --help
# or
npm install --save-dev autoremediator
npm exec autoremediator -- --help
# or
yarn add --dev autoremediator
yarn autoremediator --help
```

With Docker:

```bash
docker run --rm -v "$PWD:/workdir" ghcr.io/rawlings/autoremediator CVE-2021-23337
```

## Choose the Right Mode

| Use case | Recommended mode | Why |
|---|---|---|
| GitHub Actions CI (recommended) | reusable workflow or repo templates | Fast setup with audit mode, CI gating, and optional PR automation |
| Urgent single CVE | direct CVE mode | Fast, focused remediation and clear operator feedback |
| Non-mutating orchestration planning | `--preview` or `planRemediation()` | Evaluate intended remediation actions before mutation |
| Nightly scanner automation | scan mode (`--input`) | Batch handling with deterministic CI summary |
| Multi-repo remediation controller | `portfolio --targets-file` or `remediatePortfolio()` | Aggregate many repositories into one coordinated run |
| CI gate without mutation | `--dry-run --ci` | Safety-first check for unresolved risk |
| Air-gapped or deterministic environments | `--llm-provider local` | No remote model dependency and predictable behavior |
| Remote model-backed patch generation | `--llm-provider remote` | Uses remote adapter configuration and runtime credentials |
| Platform service integration | SDK, MCP, or OpenAPI | Standardized orchestration across many repos |

## What Newer Runs Include

Recent remediation reports can include:

- heuristic package reachability assessment based on repository imports
- alternative package suggestions when no safe upgrade exists
- human-readable fix explanations per package result
- optional pull request / merge request creation metadata

For GitHub Actions, the recommended approach is the reusable workflow or the copyable templates in this repository:

```yaml
jobs:
  gate:
    uses: rawlings/autoremediator/.github/workflows/reusable-remediate-from-audit.yml@v1
    with:
      audit: true
      dry-run: true
      ci: true
```

The reusable workflow runs audit mode by default and can also create a pull request for mutating remediation runs.
By default it keeps the generated summary JSON in runner temp so CI artifacts and PR generation do not add that file to your repository diff.
The workflow-template files under `.github/workflow-templates/` are copyable examples, not GitHub UI-discoverable starter workflows from this repository alone.
See [Integrations](integrations.md) for the action-level path, reusable workflow inputs, and template scenarios.

For full mode semantics, see [CLI Reference](cli.md) and [Integrations](integrations.md).

## First Commands (What and Why)

Direct CVE remediation:

```bash
autoremediator CVE-2021-23337
```

What it does:

- looks up CVE intelligence
- checks installed package inventory
- matches vulnerable installed versions
- attempts safe version bump first
- uses patch fallback only when no safe bump is available

Why to use it: ideal for urgent vulnerability response.

Scanner-driven remediation:

```bash
autoremediator ./audit.json
```

What it does: parses scanner output, deduplicates CVEs, and runs remediation for each CVE.

Why to use it: ideal for regular automation from `npm audit`, `yarn audit`, or SARIF tools.

Safety preview:

```bash
autoremediator CVE-2021-23337 --dry-run
```

What it does: runs full decision logic without mutating project files.

Why to use it: validate policy impact and expected changes before applying.

Planning preview with correlation context:

```bash
autoremediator CVE-2021-23337 --preview --request-id req-42 --session-id nightly-security
```

What it does: runs non-mutating planning while attaching orchestration trace identifiers to report/evidence outputs.

Why to use it: enables external automation systems to correlate remediation runs across jobs, services, and follow-up actions.

Validation-enabled apply:

```bash
autoremediator CVE-2021-23337 --run-tests
```

What it does: runs post-apply validation (install/test workflow) before final success.

Why to use it: reduce regression risk in production automation.

## Interpreting Results

A remediation run usually ends in a mix of outcomes:

- applied: a safe bump or valid patch was applied
- unresolved: remediation was attempted but could not be safely completed
- skipped: package was out of scope or blocked by policy

In CI mode (`--ci`), use the summary output as your gate decision source. See [CLI Reference](cli.md) for exit behavior and [Policy and Safety](policy-and-safety.md) for unresolved semantics.

## Security Best Practices

- start with `--dry-run` in new repositories
- keep `allowMajorBumps` disabled by default unless your release process explicitly permits breaking upgrades
- use package allow/deny policy controls for governance boundaries
- enable validation (`--run-tests`) in remediation jobs that can mutate dependencies
- treat unresolved results as escalation signals, not silent pass conditions
- preserve evidence and summary artifacts for auditability

Detailed controls are documented in [Policy and Safety](policy-and-safety.md).

## Troubleshooting First Steps

- CVE did not apply:
	- verify the vulnerable version is actually installed
	- confirm policy did not deny the package
	- inspect unresolved reason in output/evidence
- Scan file not accepted:
	- explicitly set `--format`
	- validate scanner JSON shape against [Scanner Inputs](scanner-inputs.md)
- No patch fallback generated:
	- confirm non-local provider or configured local strategy supports patch generation for your environment
	- check safety thresholds and validation outcome

For CI and scheduling patterns, continue with [Integrations](integrations.md).
