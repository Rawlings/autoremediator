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

The action also supports audit-driven execution directly:

```yaml
- uses: actions/checkout@v4
- uses: rawlings/autoremediator@v1
  with:
    audit: 'true'
    ci: 'true'
```

Audit mode uses `npm audit --json` directly and enables Corepack shims for `pnpm` and `yarn`.
If your repository needs a specific `pnpm` or `yarn` version, set that up before calling the action or declare the package manager version in `package.json`.

All scan-mode flags are available as inputs:

| Input | Description | Default |
|---|---|---|
| `scan-file` | Path to scanner output file | — |
| `audit` | Run package-manager-native audit instead of reading `scan-file` | `false` |
| `cve-id` | Single CVE ID to remediate (instead of scan-file) | — |
| `format` | `auto`, `npm-audit`, `yarn-audit`, `sarif` | `auto` |
| `cwd` | Target project directory | `.` |
| `package-manager` | `npm`, `pnpm`, `yarn` (auto-detected from lockfile) | — |
| `dry-run` | Plan only, no mutations | `false` |
| `run-tests` | Validate changes with test command | `false` |
| `ci` | Exit non-zero on unresolved CVEs | `false` |
| `summary-file` | Write machine-readable summary JSON | — |
| `policy` | Path to `.github/autoremediator.yml` | — |
| `llm-provider` | `remote`, `local` | `local` |
| `node-version` | Node.js version (24+) | `24` |
| `token` | GitHub token for PR creation | `github.token` |
| `create-pull-request` | Open a pull request with remediated changes | `false` |
| `pull-request-branch` | Branch name prefix for the fix branch | — |
| `pull-request-title` | Title for the pull request | — |
| `pull-request-commit-message` | Commit message for remediation commits | — |

`scan-file`, `audit`, and `cve-id` are mutually exclusive.

### Pull Request Creation

Composite actions cannot declare `permissions` — the calling job must grant them.
When using `create-pull-request: 'true'`, the job needs write access to repository contents and pull requests:

```yaml
jobs:
  remediate:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - run: pnpm audit --json > audit.json || true
      - uses: rawlings/autoremediator@v1
        with:
          scan-file: audit.json
          create-pull-request: 'true'
```

The `token` input defaults to `${{ github.token }}`. Explicitly passing a token is only needed when using a custom app token or a PAT scoped to a different repository.

When `dry-run: 'true'` is set, `create-pull-request` is ignored — no remote mutations occur in dry-run mode.

## GitHub Actions Reusable Workflow

For repositories that want a Dependabot-like setup without copying several job steps, use the reusable workflow in this repository.
It wraps the Marketplace action and is designed to support automatic remediation with reviewable pull requests.

```yaml
name: autoremediator-remediate

on:
  pull_request:
  push:
    branches: [main]

jobs:
  remediate:
    uses: rawlings/autoremediator/.github/workflows/reusable-remediate-from-audit.yml@v1
    with:
      audit: true
      dry-run: false
      ci: true
      create-pull-request: true
```

If you only want an enforcement gate without applying changes, keep `dry-run: true` and omit `create-pull-request`.

The reusable workflow exposes the same remediation inputs as the action plus workflow-only controls for:

- `create-pull-request`
- `pull-request-branch`
- `pull-request-title`
- `pull-request-commit-message`
- `pull-request-body-header`
- `upload-summary-artifact`
- `summary-artifact-name`

When `summary-file` is omitted, the reusable workflow writes the summary JSON into the runner temp directory so it can be uploaded or used for PR composition without being committed into the repository.

Use a pinned commit SHA for strict reproducibility, or use the floating major tag (`@v1`) for convenient upgrades.

## Starter Workflow Templates

This repository now includes copyable workflow templates under `.github/workflow-templates/` for:

- enforcement-only gating
- nightly remediation pull requests
- SARIF upload to GitHub code scanning

These files are intended as copyable examples in this repository.
They are not GitHub UI-discoverable starter workflows unless they are also published from a dedicated public `.github` template repository.

## GitHub App Runtime (Production Mode)

The `packages/github-app` runtime provides signed webhook intake, delivery idempotency, installation lifecycle state, installation token exchange, persistent queue execution, and optional scheduled orchestration.

### Real GitHub App Setup

The server exposes a `/setup` endpoint that registers the app on GitHub automatically using the [App Manifest API](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). Permissions, events, and the webhook URL are all pre-filled — no manual GitHub App configuration required.

1. Set `AUTOREMEDIATOR_GITHUB_APP_BASE_URL` to the public URL of this server (e.g. `https://autoremediator.example.com`) and start the server without the `APP_ID` / `PRIVATE_KEY` / `WEBHOOK_SECRET` credentials.
2. Navigate to `https://<your-host>/setup` in a browser. The page renders a one-click registration form.
3. Click **Create GitHub App on GitHub**. GitHub pre-fills the form from this server's manifest and redirects back to `/setup/complete` with your credentials on confirmation.
4. Copy the three env vars shown (`AUTOREMEDIATOR_GITHUB_APP_ID`, `AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY`, `AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET`), set them, and restart the server.
5. Install the app on the repositories you want to remediate. GitHub calls `/install` on successful installation, which the server acknowledges and tracks.

Permissions declared in the manifest:

- `Contents`: Read and write (version bumps and lockfile mutations)
- `Pull requests`: Read and write (native PR creation)
- `Checks`: Read and write (check run status publishing)
- `Metadata`: Read-only (default)

Events: `check_suite`, `installation`, `installation_repositories`, `workflow_dispatch`

Environment variables:

| Variable | Description | Required |
|---|---|---|
| `AUTOREMEDIATOR_GITHUB_APP_ID` | GitHub App ID | yes |
| `AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM) | yes |
| `AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET` | Webhook signature secret | yes |
| `AUTOREMEDIATOR_GITHUB_APP_PORT` | HTTP listen port (default `3001`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_BASE_URL` | Public URL of this server, used by `/setup` to build the app manifest (e.g. `https://autoremediator.example.com`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_ENABLE_SETUP_ROUTES` | Enable `/setup`, `/setup/complete`, and `/install` registration routes (default `true`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_GITHUB_URL` | GitHub base URL for GitHub Enterprise Server (default `https://github.com`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_GITHUB_API_URL` | GitHub API base URL for GitHub Enterprise Server (default `https://api.github.com`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_DATA_DIR` | Optional persistent state directory for restart-safe dedupe and installation state | no |
| `AUTOREMEDIATOR_GITHUB_APP_TRIGGER_TIMEOUT_MS` | Optional callback timeout in ms for remediation trigger handlers | no |
| `AUTOREMEDIATOR_GITHUB_APP_ENABLE_DEFAULT_REMEDIATION` | Enable built-in remediation adapter for `check_suite` and `workflow_dispatch` events | no |
| `AUTOREMEDIATOR_GITHUB_APP_LOG_EVENT_TRACES` | Emit one JSON line per processed webhook event with status and reason | no |
| `AUTOREMEDIATOR_GITHUB_APP_MAX_WEBHOOK_BODY_BYTES` | Maximum accepted webhook request body size in bytes (default `262144`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_REQUIRE_JSON_CONTENT_TYPE` | Require `application/json` content type for webhook requests (default `true`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_ALLOWED_EVENTS` | Comma-separated allowlist of accepted webhook event names | no |
| `AUTOREMEDIATOR_GITHUB_APP_REQUIRE_DELIVERY_ID` | Require `x-github-delivery` header for webhook requests | no |
| `AUTOREMEDIATOR_GITHUB_APP_ENABLE_JOB_QUEUE` | Enable queue-backed asynchronous remediation execution (default `true`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_QUEUE_POLL_INTERVAL_MS` | Job worker poll interval in milliseconds (default `2000`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_QUEUE_RETRY_DELAY_MS` | Delay before retrying failed jobs in milliseconds (default `15000`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_QUEUE_MAX_ATTEMPTS` | Maximum attempts per queued remediation job (default `3`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_WORKER_CONCURRENCY` | Maximum number of concurrent queue jobs (default `1`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_ENABLE_SCHEDULER` | Enable interval scheduler that enqueues `workflow_dispatch` jobs | no |
| `AUTOREMEDIATOR_GITHUB_APP_SCHEDULE_INTERVAL_MS` | Scheduler interval in milliseconds (default `3600000`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_ENABLE_STATUS_PUBLISHING` | Publish GitHub check run results for queued and completed remediation jobs (requires app credentials; default `false`) | no |
| `AUTOREMEDIATOR_GITHUB_APP_STATUS_CHECK_NAME` | Name displayed on the GitHub check run (default `autoremediator/remediation`) | no |

When `AUTOREMEDIATOR_GITHUB_APP_DATA_DIR` is set, webhook state and job queue state are persisted across restarts.
When `AUTOREMEDIATOR_GITHUB_APP_DATA_DIR` is not set, runtime state and queue are in-memory only.
When `AUTOREMEDIATOR_GITHUB_APP_ENABLE_DEFAULT_REMEDIATION` is `true`, queued trigger jobs run `remediateFromScan` in audit mode.
For jobs with an installation context, the app exchanges installation tokens through GitHub App authentication before invoking remediation callbacks.

Per-repository remediation behavior (dry-run mode, severity filter, pull request settings, and upgrade constraints) is configured through `.github/autoremediator.yml` checked in to each target repository.
The GitHub App fetches this file via the GitHub API on each webhook delivery and falls back to safe defaults when the file is absent.
See [Policy and Safety](policy-and-safety.md) for the full YAML schema and field reference.

Webhook responses include an `x-request-id` header (propagated when provided by caller, otherwise generated).
The `/health` endpoint includes in-memory runtime counters (`totalRequests`, `webhookRequests`, `handled`, `ignored`, `duplicate`, `rejected`) and grouped maps (`byEvent`, `byStatusCode`) for operational visibility.
It also includes `latency.averageMs` and `latency.maxMs` derived from processed and rejected webhook requests.

Local run commands:

```bash
pnpm build:github-app
pnpm start:github-app
```

### Quickstart Profile (Automatic PRs)

Use this profile when you want the runtime to remediate and open pull requests automatically. Enable the default remediation handler via env var, then configure per-repo behavior in `.github/autoremediator.yml`:

```bash
AUTOREMEDIATOR_GITHUB_APP_ENABLE_DEFAULT_REMEDIATION=true
```

```yaml
# .github/autoremediator.yml (committed to each target repository)
dryRun: false
runTests: true
minimumSeverity: HIGH
pullRequest:
  enabled: true
  grouping: per-cve
```

### Operator Runbook (Recommended Production Defaults)

Use these defaults as a baseline for production rollout, then tune by repository size and runner capacity:

```bash
AUTOREMEDIATOR_GITHUB_APP_REQUIRE_JSON_CONTENT_TYPE=true
AUTOREMEDIATOR_GITHUB_APP_REQUIRE_DELIVERY_ID=true
AUTOREMEDIATOR_GITHUB_APP_MAX_WEBHOOK_BODY_BYTES=262144
AUTOREMEDIATOR_GITHUB_APP_ENABLE_JOB_QUEUE=true
AUTOREMEDIATOR_GITHUB_APP_QUEUE_POLL_INTERVAL_MS=2000
AUTOREMEDIATOR_GITHUB_APP_QUEUE_RETRY_DELAY_MS=30000
AUTOREMEDIATOR_GITHUB_APP_QUEUE_MAX_ATTEMPTS=4
AUTOREMEDIATOR_GITHUB_APP_WORKER_CONCURRENCY=2
AUTOREMEDIATOR_GITHUB_APP_ENABLE_SCHEDULER=false
AUTOREMEDIATOR_GITHUB_APP_SCHEDULE_INTERVAL_MS=3600000
AUTOREMEDIATOR_GITHUB_APP_ENABLE_DEFAULT_REMEDIATION=false
AUTOREMEDIATOR_GITHUB_APP_LOG_EVENT_TRACES=true
```

Rollout checklist:

1. Set `AUTOREMEDIATOR_GITHUB_APP_DATA_DIR` to durable storage so webhook and queue state survive restarts.
2. Start with `AUTOREMEDIATOR_GITHUB_APP_ENABLE_DEFAULT_REMEDIATION=false` and wire a custom callback first.
3. Keep `AUTOREMEDIATOR_GITHUB_APP_ENABLE_SCHEDULER=false` until webhook-triggered flow is stable.
4. Monitor `/health` for webhook counters, latency, and queue depth/failed-job growth.
5. Increase `AUTOREMEDIATOR_GITHUB_APP_WORKER_CONCURRENCY` only after repository test/install capacity is validated.

## GitHub Actions: Scheduled Auto-Remediation PRs

Nightly remediation with automatic PR creation can now be packaged through the reusable workflow.

```yaml
name: autoremediator-nightly

on:
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:

jobs:
  remediate:
    permissions:
      contents: write
      pull-requests: write
    uses: rawlings/autoremediator/.github/workflows/reusable-remediate-from-audit.yml@v1
    with:
      audit: true
      upload-summary-artifact: true
      create-pull-request: true
      pull-request-branch: chore/autoremediator-nightly
      pull-request-title: "chore: automated CVE remediation"
      pull-request-commit-message: "chore: automated CVE remediation"
```

This workflow-layer PR automation is distinct from autoremediator's native change-request capabilities.
Use it when you want GitHub Actions-managed pull request creation without enabling provider-specific change-request logic in the runtime.

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
    uses: rawlings/autoremediator/.github/workflows/reusable-remediate-from-audit.yml@v1
    with:
      audit: true
      dry-run: true
      ci: true
      upload-summary-artifact: true
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
