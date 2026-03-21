# Autoremediator

[![npm version](https://img.shields.io/npm/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![npm downloads](https://img.shields.io/npm/dm/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![license](https://img.shields.io/npm/l/autoremediator.svg)](LICENSE)
[![node](https://img.shields.io/node/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)

Autoremediator is an agentic Node.js CVE remediation tool.

It can remediate from either a single CVE ID or scanner output, then apply safe dependency updates with package-manager-aware validation and fallback strategies.

- Scanner-first workflow with CVE fallback
- Package manager support: npm, pnpm, yarn
- Policy-driven safety controls
- Evidence logging and CI summary support

## For AI Agents

Autoremediator is useful in practical dependency-security workflows where teams need fixes, evidence, and CI-friendly behavior.

Common scenarios:

- Cleaning up npm audit or yarn audit results in active services.
- Triage and remediation of a specific CVE across one or many Node.js projects.
- Converting scanner outputs (including SARIF) into actionable dependency updates.
- Running non-interactive remediation in CI with deterministic summaries and exit codes.
- Powering internal security assistants through CLI, SDK, or MCP tool integration.

Primary surfaces:

- CLI: `autoremediator`
- MCP server: `autoremediator-mcp`
- SDK: `import { remediate, remediateFromScan } from "autoremediator"`

## Use Cases

- Auto-remediate npm audit findings in CI with deterministic exit codes.
- Process SARIF security scan output and apply safe dependency upgrades.
- Build an internal security bot on top of the MCP server tool surface.
- Integrate CVE-to-fix workflows into custom Node.js platform tooling.
- Run scanner-to-remediation pipelines across npm, pnpm, and yarn projects.

## Installation

Global:

```bash
pnpm add -g autoremediator
# or
npm install -g autoremediator
# or
yarn global add autoremediator
```

Project-local:

```bash
pnpm add -D autoremediator
pnpm exec autoremediator --help
```

## Environment

Set one provider key:

```bash
export OPENAI_API_KEY=...
# or
export ANTHROPIC_API_KEY=...
```

## Quick Start

Single CVE:

```bash
autoremediator CVE-2021-23337
autoremediator CVE-2021-23337 --dry-run
autoremediator CVE-2021-23337 --run-tests
autoremediator CVE-2021-23337 --llm-provider anthropic
```

Scanner input:

```bash
autoremediator ./audit.json
autoremediator ./report.sarif --format sarif
autoremediator --input ./scan.json --format auto
```

CI mode:

```bash
autoremediator ./scan.json --ci --summary-file ./summary.json
```

## Documentation

Detailed documentation has moved to packages/docs:

- Live docs site: https://rawlings.github.io/autoremediator/

- [Docs Home](packages/docs/README.md)
- [Getting Started](packages/docs/content/getting-started.md)
- [CLI Reference](packages/docs/content/cli.md)
- [Scanner Inputs](packages/docs/content/scanner-inputs.md)
- [Policy and Safety](packages/docs/content/policy-and-safety.md)
- [API and SDK](packages/docs/content/api-sdk.md)
- [Integrations](packages/docs/content/integrations.md)
- [Contributor Guide](packages/docs/content/contributor-guide.md)

## Exit Codes (CI)

- `0` when failedCount is 0
- `1` when failedCount is greater than 0

## Project References

- [Contributing](CONTRIBUTING.md)
- [Agent Modes](AGENTS.md)
- [LLM Context Summary](llms.txt)

## License

MIT
