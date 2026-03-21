# Integrations

This page documents integration patterns for automation-first remediation.

It focuses on what each integration does, why to choose it, and how to operate it safely.

Related references:

- [Getting Started](getting-started.md)
- [CLI Reference](cli.md)
- [Policy and Safety](policy-and-safety.md)
- [API and SDK](api-sdk.md)

## Integration Decision Guide

| Pattern | Use when | Key outcome |
|---|---|---|
| Scheduled PR automation | you want continuous improvement with review gates | automatic remediation PRs on a cadence |
| Enforcement-only gate | you want fail-fast security gating in PR/merge pipelines | deterministic pass/fail based on unresolved outcomes |
| SDK integration | you need custom control flow in internal tooling | programmable orchestration and reporting |
| MCP server | you integrate with AI-host tool ecosystems | standardized tool interface for remediation workflows |
| OpenAPI server | you need service-based central remediation execution | networked API access for multi-system orchestration |

## GitHub Actions: Scheduled Auto-Remediation PRs

Use this for regular remediation with human review.

Why this pattern works:

- shortens vulnerability exposure windows
- preserves branch protection and review controls
- creates auditable PR history

### pnpm workflow

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
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm audit --json > audit.json || true
      - run: pnpm exec autoremediator scan --input ./audit.json --format npm-audit --ci --summary-file ./autoremediator-summary.json
      - uses: peter-evans/create-pull-request@v6
        with:
          branch: chore/autoremediator-nightly
          commit-message: "chore: automated CVE remediation"
          title: "chore: automated CVE remediation"
```

### npm workflow

```yaml
name: autoremediator-nightly-npm

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
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm audit --json > audit.json || true
      - run: npm exec autoremediator -- scan --input ./audit.json --format npm-audit --ci --summary-file ./autoremediator-summary.json
      - uses: peter-evans/create-pull-request@v6
        with:
          branch: chore/autoremediator-nightly
          commit-message: "chore: automated CVE remediation"
          title: "chore: automated CVE remediation"
```

### yarn workflow

```yaml
name: autoremediator-nightly-yarn

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
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: yarn
      - run: corepack enable
      - run: yarn install --immutable || yarn install --frozen-lockfile
      - run: yarn npm audit --json > audit.json || yarn audit --json > audit.json || true
      - run: yarn autoremediator scan --input ./audit.json --format yarn-audit --ci --summary-file ./autoremediator-summary.json
      - uses: peter-evans/create-pull-request@v6
        with:
          branch: chore/autoremediator-nightly
          commit-message: "chore: automated CVE remediation"
          title: "chore: automated CVE remediation"
```

## GitHub Actions: Enforcement-Only Gate

Use this when you want CI to fail on unresolved remediation outcomes without opening PRs.

Why this pattern works:

- makes unresolved risk explicit in merge workflow
- prevents silent vulnerability drift
- keeps dependency mutation out of gate jobs

### pnpm workflow

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
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm audit --json > audit.json || true
      - run: pnpm exec autoremediator scan --input ./audit.json --format npm-audit --ci --summary-file ./summary.json --dry-run
```

### npm workflow

```yaml
name: autoremediator-gate-npm

on:
  pull_request:
  push:
    branches: [main]

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm audit --json > audit.json || true
      - run: npm exec autoremediator -- scan --input ./audit.json --format npm-audit --ci --summary-file ./summary.json --dry-run
```

### yarn workflow

```yaml
name: autoremediator-gate-yarn

on:
  pull_request:
  push:
    branches: [main]

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: yarn
      - run: corepack enable
      - run: yarn install --immutable || yarn install --frozen-lockfile
      - run: yarn npm audit --json > audit.json || yarn audit --json > audit.json || true
      - run: yarn autoremediator scan --input ./audit.json --format yarn-audit --ci --summary-file ./summary.json --dry-run
```

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
- `remediateFromScan`

Why use MCP: standard tool contracts for AI host ecosystems, with typed request/response patterns.

## OpenAPI Integration

Start OpenAPI server:

```bash
node dist/openapi/server.js --port 3000
```

Routes:

- `POST /remediate`
- `POST /remediate-from-scan`
- `GET /openapi.json`
- `GET /health`

Why use OpenAPI: central remediation service for multiple clients and repositories.

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
