# Integrations

## GitHub Actions: Scheduled Auto-Remediation PRs

Use this when you want automatic remediation runs that open pull requests on a cadence.

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
      - run: pnpm exec autoremediator scan --input ./audit.json --ci --summary-file ./autoremediator-summary.json
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
      - run: npm exec autoremediator -- scan --input ./audit.json --ci --summary-file ./autoremediator-summary.json
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
      - run: yarn autoremediator scan --input ./audit.json --ci --summary-file ./autoremediator-summary.json
      - uses: peter-evans/create-pull-request@v6
        with:
          branch: chore/autoremediator-nightly
          commit-message: "chore: automated CVE remediation"
          title: "chore: automated CVE remediation"
```

## GitHub Actions: Enforcement-Only Gate

Use this when you want CI to fail on unresolved remediations without auto-PR creation.

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
      - run: pnpm exec autoremediator --input ./audit.json --format auto --ci --summary-file ./summary.json
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
      - run: npm exec autoremediator -- --input ./audit.json --format auto --ci --summary-file ./summary.json
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
      - run: yarn autoremediator --input ./audit.json --format auto --ci --summary-file ./summary.json
```

## MCP

```bash
autoremediator-mcp
```

Tools exposed:

- `remediate`
- `remediateFromScan`

## OpenAPI

```bash
node dist/openapi/server.js --port 3000
```

Routes:

- `POST /remediate`
- `POST /remediate-from-scan`
- `GET /openapi.json`
- `GET /health`

## CLI in CI

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
