# Autoremediator

[![npm version](https://img.shields.io/npm/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![license](https://img.shields.io/npm/l/autoremediator.svg)](LICENSE)
[![node](https://img.shields.io/node/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)

Fixes vulnerable npm dependencies. Give it a CVE or GHSA id, or the output of a scanner, and it
upgrades, overrides or patches the affected packages, verifies the result, and reports exactly what
it did and what it could not fix.

> [!WARNING]
> Automated dependency changes carry operational and supply-chain risk. Run with `--dry-run` first,
> keep CI gates and branch protection in place, and set a [policy](docs/policy.md).

```bash
npx autoremediator CVE-2021-23337 --dry-run     # preview
npx autoremediator CVE-2021-23337 --run-tests   # apply and verify
npx autoremediator --audit                      # remediate whatever `npm audit` reports
```

Requires Node.js 26+.

## What it does

For each installed package in a vulnerable range, it tries, in order:

1. a **version bump** to the lowest safe version;
2. a **package-manager override** when the package is transitive;
3. a **generated patch**, only when no safe version exists and you have configured a model.

Every change is installed, optionally tested and type-checked, and rolled back if anything fails.
Unfixed findings are reported with an explicit reason, never dropped.

Advisories come from OSV, the GitHub Advisory Database and NVD; CISA KEV and EPSS add exploit
signals. A [policy file](docs/policy.md) controls which packages may change, how confident a patch
must be, and whether a result is applied automatically, held for approval, or escalated.

## Ways to run it

CLI · SDK · [GitHub Action](docs/integrations.md#github-action) ·
[GitHub App](docs/integrations.md#github-app) · [MCP server](docs/integrations.md#mcp-server) ·
[HTTP server](docs/integrations.md#http-server)

## Documentation

- [Usage](docs/usage.md): commands, how fixes are chosen, scanner inputs, SDK
- [Policy and safety](docs/policy.md): the policy file and the guarantees
- [Integrations](docs/integrations.md): Action, MCP, HTTP, GitHub App
- [Architecture](docs/architecture.md) and [Contributing](CONTRIBUTING.md)
- [AGENTS.md](AGENTS.md), [llms.txt](llms.txt): machine-readable summaries

## License

MIT
