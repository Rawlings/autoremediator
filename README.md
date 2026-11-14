# Autoremediator

[![npm version](https://img.shields.io/npm/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![license](https://img.shields.io/npm/l/autoremediator.svg)](LICENSE)
[![node](https://img.shields.io/node/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)

Fixes vulnerable npm dependencies. Give it a CVE or GHSA id, or the output of a scanner, and it
upgrades, overrides or patches the affected packages, verifies the result, and reports what it did
and what it could not fix.

> [!WARNING]
> Automated dependency changes carry operational and supply-chain risk. Start with `--dry-run`, keep
> CI and branch protection in place, and set a [policy](docs/reference/policy-file.md).

```bash
npx autoremediator CVE-2021-23337 --dry-run     # preview
npx autoremediator CVE-2021-23337 --run-tests   # apply and verify
npx autoremediator --audit                      # fix whatever the package manager's audit reports
```

Requires Node.js 26 or later. Works with npm, pnpm, Yarn, Bun and Deno projects.

## How it fixes things

For each installed package in a vulnerable range it tries, in order:

1. a **version bump** to the lowest safe version;
2. a **package-manager override**, when the package is transitive;
3. a **generated patch**, only when no safe version exists and you have configured a model.

Every change is installed, optionally tested and type-checked, and rolled back if anything fails.
Whatever cannot be fixed is reported with a reason. See [How it works](docs/how-it-works.md).

## Where it runs

| Surface | Use it for |
| ------- | ---------- |
| CLI and [SDK](docs/reference/sdk.md) | Local runs, scripts, pipelines |
| [GitHub Action](docs/integrations/github-action.md) | Scheduled or per-PR remediation with a pull request |
| [GitHub App](docs/integrations/github-app.md) | Hosted remediation across repositories |
| [MCP server](docs/integrations/mcp-server.md) | Editors and agents |
| [HTTP server](docs/integrations/http-server.md) | Internal services |
| [VS Code extension](packages/vscode-extension/README.md) | Findings in `package.json` |

## Documentation

Start at the [documentation index](docs/README.md).

- [Getting started](docs/getting-started.md)
- [How it works](docs/how-it-works.md) and [Safety](docs/safety.md)
- Guides: [scanners](docs/guides/scanners.md), [automation and CI](docs/guides/automation.md),
  [patch generation](docs/guides/patch-generation.md), [offline use](docs/guides/offline.md)
- Reference: [CLI](docs/reference/cli.md), [SDK](docs/reference/sdk.md),
  [policy file](docs/reference/policy-file.md), [environment](docs/reference/environment.md)
- Contributing: [guide](CONTRIBUTING.md), [architecture](docs/contributing/architecture.md)

## License

[MIT](LICENSE)
