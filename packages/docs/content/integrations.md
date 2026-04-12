# Integrations

This page documents integration patterns for risk-aware, agentic remediation.

It focuses on what each integration does, why to choose it, and how to operate it safely with EPSS, CISA KEV, and OSV intelligence plus auditable evidence outputs.

Related references:

- [Getting Started](getting-started.md)
- [CLI Reference](cli.md)
- [Policy and Safety](policy-and-safety.md)
- [API and SDK](api-sdk.md)
- [Agent Ecosystems](agent-ecosystems.md)

## Integration Decision Guide

| Pattern | Use when | Key outcome |
|---|---|---|
| Risk-prioritized triage in CI | you need to reduce vulnerability fatigue from noisy scanner output | focus remediation on known-exploited and higher-probability CVEs first |
| GitHub Actions Marketplace action | you want zero-boilerplate CI integration | one step, works with pnpm/npm/yarn |
| VS Code extension | you want inline diagnostics while editing | squiggles + code action on package.json |
| Scheduled PR automation | you want continuous improvement with review gates | automatic remediation PRs on a cadence |
| Enforcement-only gate | you want fail-fast security gating in PR/merge pipelines | deterministic pass/fail based on unresolved outcomes |
| SARIF upload | you want results in GitHub Security tab | Code Scanning alerts alongside other tools |
| SDK integration | you need custom control flow in internal tooling | programmable orchestration and reporting |
| MCP server | you integrate with AI-host tool ecosystems | standardized tool interface for remediation workflows |
| OpenAPI server | you need service-based central remediation execution | networked API access for multi-system orchestration |
| Portfolio orchestration | you coordinate many repositories from one control plane | one aggregated report plus optional per-target change requests |

## GitHub Code Scanning: SARIF Upload

Use `--output-format sarif` to emit SARIF 2.1.0 output, then upload directly to GitHub's Security tab via `actions/upload-sarif`.

This makes autoremediator results appear as Code Scanning alerts alongside other security tools.

```yaml
name: autoremediator-sarif

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "0 3 * * *"

jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm audit --json > audit.json || true
      - run: pnpm exec autoremediator scan --input audit.json --dry-run --output-format sarif > results.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
```

For npm or yarn, substitute the audit and exec commands accordingly.

The `--dry-run` flag ensures this job is read-only — no changes are made to the project.

## Native Review Creation

Autoremediator can create native GitHub pull requests or GitLab merge requests directly from remediation runs.

Typical CLI pattern:

```bash
autoremediator ./audit.json \
  --create-change-request \
  --change-request-provider github \
  --change-request-grouping per-cve
```

This is useful when you want the remediation controller to finish with a reviewable branch instead of leaving changed files in place.

Grouped change requests use:

- `all`: one batched review for the whole run
- `per-cve`: one review branch per CVE
- `per-package`: package-group planning with isolated worktrees

GitHub uses `GITHUB_TOKEN` by default. GitLab uses `GITLAB_TOKEN` by default. You can override the token env var through the public `changeRequest.tokenEnvVar` option.

Execution environments must also provide the matching provider CLI: `gh` for GitHub pull requests and `glab` for GitLab merge requests.

## Portfolio Orchestration

For platform-owned fleets, use `remediatePortfolio` or `autoremediator portfolio --targets-file`.

Each target points at one repository root and chooses either a direct CVE flow or a scan-driven flow. The resulting portfolio report rolls up per-target status and any created change requests.

Portfolio change-request aggregation uses the same native review creation path as single-repository scan runs, including grouped review strategies and provider CLI requirements.

## GitHub Actions Marketplace Action

The `rawlings/autoremediator` action installs and runs autoremediator in a single step.
Node.js setup and package installation are handled inside the action — no boilerplate needed.

Works with **pnpm, npm, and yarn**. Run your package manager's audit first to produce the input file, then pass it to the action:

```yaml
# pnpm
- run: pnpm audit --json > audit.json || true
- uses: rawlings/autoremediator@v1
  with:
    scan-file: audit.json

# npm
- run: npm audit --json > audit.json || true
- uses: rawlings/autoremediator@v1
  with:
    scan-file: audit.json

# yarn
- run: yarn npm audit --json > audit.json || yarn audit --json > audit.json || true
- uses: rawlings/autoremediator@v1
  with:
    scan-file: audit.json
    format: yarn-audit
```

All scan-mode flags are available as inputs:

| Input | Description | Default |
|---|---|---|
| `scan-file` | Path to scanner output file | — |
| `cve-id` | Single CVE ID to remediate (instead of scan-file) | — |
| `format` | `auto`, `npm-audit`, `yarn-audit`, `sarif` | `auto` |
| `cwd` | Target project directory | `.` |
| `package-manager` | `npm`, `pnpm`, `yarn` (auto-detected from lockfile) | — |
| `dry-run` | Plan only, no mutations | `false` |
| `run-tests` | Validate changes with test command | `false` |
| `ci` | Exit non-zero on unresolved CVEs | `false` |
| `summary-file` | Write machine-readable summary JSON | — |
| `policy` | Path to `.autoremediator.json` | — |
| `llm-provider` | `remote`, `local` | `local` |
| `node-version` | Node.js version (24+) | `24` |

## GitHub Actions: Scheduled Auto-Remediation PRs

Nightly remediation with automatic PR creation. The action handles Node.js and autoremediator installation —
you only need the audit step and the PR creator.

```yaml
name: autoremediator-nightly

on:
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:

jobs:
  remediate:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - run: pnpm audit --json > audit.json || true   # or: npm audit / yarn audit
      - uses: rawlings/autoremediator@v1
        with:
          scan-file: audit.json
          summary-file: autoremediator-summary.json
      - uses: peter-evans/create-pull-request@v6
        with:
          branch: chore/autoremediator-nightly
          commit-message: "chore: automated CVE remediation"
          title: "chore: automated CVE remediation"
```

This works for npm and yarn too — substitute the audit command on the `run:` line and set `format: yarn-audit` if using yarn.

The generated summary file includes aggregate fields such as `strategyCounts`, `dependencyScopeCounts`, and `unresolvedByReason`, which are useful for PR descriptions, dashboards, and CI policy checks.

## GitHub Actions: Enforcement-Only Gate

Fail the build when unresolved CVEs remain. Uses `dry-run` so no files are mutated.

```yaml
name: autoremediator-gate

on:
  pull_request:
  push:
    branches: [main]

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm audit --json > audit.json || true   # or: npm audit / yarn audit
      - uses: rawlings/autoremediator@v1
        with:
          scan-file: audit.json
          dry-run: 'true'
          ci: 'true'
          summary-file: summary.json
```

The summary JSON is designed for automation consumption: `strategyCounts` shows which remediation path was used, `dependencyScopeCounts` distinguishes direct dependency work from transitive remediation, and `unresolvedByReason` lets CI react to specific failure classes without parsing human-readable messages.

## Multi-Stage Automation Pattern

For high-assurance environments, use staged jobs:

1. scanner export stage
2. dry-run gate stage
3. mutation-enabled remediation stage (optional)
4. validation/test stage
5. PR creation and review stage

This sequence improves rollback posture and traceability.

## MCP Integration

Start MCP server:

```bash
autoremediator-mcp
```

Tools exposed:

- `remediate`
- `planRemediation`
- `remediateFromScan`
- `listPatchArtifacts`
- `inspectPatchArtifact`
- `validatePatchArtifact`

Why use MCP: standard tool contracts for AI host ecosystems, with typed request/response patterns.

The scan-oriented MCP response includes the same aggregate summary fields used by the SDK and CLI, including `strategyCounts`, `dependencyScopeCounts`, and `unresolvedByReason`.

For patch fallback workflows, MCP callers can treat patch artifacts as durable assets by listing, inspecting, and validating them in follow-up automation.

For plan-first orchestration guidance, see [Agent Ecosystems](agent-ecosystems.md).

## OpenAPI Integration

Start OpenAPI server:

```bash
node dist/openapi/server.js --port 3000
```

Routes:

- `POST /remediate`
- `POST /plan-remediation`
- `POST /remediate-from-scan`
- `POST /patches/list`
- `POST /patches/inspect`
- `POST /patches/validate`
- `GET /openapi.json`
- `GET /health`

Why use OpenAPI: central remediation service for multiple clients and repositories.

The OpenAPI responses expose the same aggregate reporting fields as the SDK and CLI, so service consumers can build routing and governance logic around `strategyCounts`, `dependencyScopeCounts`, and `unresolvedByReason` without custom post-processing.

Patch lifecycle OpenAPI operations provide artifact inventory and drift validation for external orchestrators that run follow-up governance checks.

For orchestration sequencing patterns, see [Agent Ecosystems](agent-ecosystems.md).

Security guidance:

- place server behind authenticated network boundaries
- restrict callers and apply least-privilege credentials
- retain request/summary artifacts for audit trails

## CLI in CI

Generic invocation:

```bash
autoremediator ./audit.json --ci --summary-file ./summary.json
```

Equivalent package-manager execution patterns:

```bash
# pnpm
pnpm exec autoremediator ./audit.json --ci --summary-file ./summary.json

# npm
npm exec autoremediator -- ./audit.json --ci --summary-file ./summary.json

# yarn
yarn autoremediator ./audit.json --ci --summary-file ./summary.json
```

## Operational Best Practices

- default new automation to dry-run until policy controls are validated
- keep branch protections enabled for remediation PR branches
- pin Node and package-manager versions in workflow jobs
- use explicit scanner format where possible
- route unresolved outcomes to a tracked escalation workflow

## Related Docs

- [CLI Reference](cli.md)
- [Scanner Inputs](scanner-inputs.md)
- [Policy and Safety](policy-and-safety.md)
- [API and SDK](api-sdk.md)
