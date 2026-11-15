<h1 align="center">Autoremediator</h1>

<p align="center"><strong>Your scanner finds vulnerabilities. Autoremediator fixes them.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/autoremediator"><img alt="npm version" src="https://img.shields.io/npm/v/autoremediator?color=cb3837&logo=npm"></a>
  <a href="https://www.npmjs.com/package/autoremediator"><img alt="npm downloads" src="https://img.shields.io/npm/dm/autoremediator?logo=npm"></a>
  <a href="https://github.com/Rawlings/autoremediator/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Rawlings/autoremediator/ci.yml?branch=master&logo=github&label=CI"></a>
  <a href="https://www.npmjs.com/package/autoremediator"><img alt="node" src="https://img.shields.io/node/v/autoremediator?logo=nodedotjs&logoColor=white"></a>
  <a href="https://www.npmjs.com/package/autoremediator"><img alt="types" src="https://img.shields.io/npm/types/autoremediator?logo=typescript&logoColor=white"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/autoremediator"></a>
  <a href="https://github.com/Rawlings/autoremediator/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Rawlings/autoremediator?style=flat&logo=github"></a>
</p>

<p align="center">
  <a href="docs/getting-started.md">Getting started</a> ·
  <a href="docs/how-it-works.md">How it works</a> ·
  <a href="docs/integrations/github-action.md">GitHub Action</a> ·
  <a href="docs/README.md">Docs</a>
</p>

Hand it a CVE or GHSA id, or your scanner's report (package manager audit or SARIF). It works out
the safest fix, applies it, runs your tests, and rolls back if anything breaks. What it cannot fix,
it tells you, with the reason.

```bash
npx autoremediator --audit --run-tests
```

## The problem

Scanners and update bots tell you what is wrong, or open a pull request for one bump at a time.
Turning findings into a safe change is still manual work: which version is actually fixed, is the
vulnerable package buried three levels deep, will the upgrade break the build, and what do you do
when no fixed version exists? Findings pile up, and the one being exploited in the wild waits in the
same queue as the rest.

## What it does for each vulnerable package

| Situation | What Autoremediator does |
| --------- | ------------------------ |
| A fixed version exists | Bumps to the **lowest** safe version, keeping the change small |
| The package is transitive | Pins the fix with your package manager's own `overrides` or `resolutions` |
| No fixed version exists | Generates a reviewable `.patch` file, if you configure a model |
| It cannot be fixed safely | Leaves your code alone and reports exactly why |

Every change is installed, tested if you ask, and **rolled back on failure**. Nothing is reported as
fixed that was not verified.

## Why you can rely on it

- **Verified, not hopeful.** Install, tests, type check and an optional proof-of-fix run before a
  change is kept.
- **Honest reports.** Unfixed findings carry a machine-readable reason, never a silent skip.
- **Exploit-aware.** CISA KEV and EPSS signals and your SLA windows decide what is urgent.
- **You set the autonomy.** A [policy file](docs/reference/policy-file.md) controls what may change.
  Each result is applied, held for approval or escalated.
- **The model is optional and boxed in.** It is used only to draft patches when no fix exists. Its
  output is syntax-checked and confidence-gated, and its tests are never run.
- **Deterministic everywhere else.** The same input gives the same plan, and `--offline` runs from a
  local advisory snapshot.

## Run it where you work

| | |
| --- | --- |
| **CLI and [SDK](docs/reference/sdk.md)** | Local runs, scripts, pipelines |
| **[GitHub Action](docs/integrations/github-action.md)** | A nightly pull request that fixes what audit finds |
| **[GitHub App](docs/integrations/github-app.md)** | Remediation across every repository you install it on |
| **[Coding agents](docs/integrations/coding-agents.md)** | `npx autoremediator init` sets up Claude Code, Cursor, VS Code, Copilot, Codex and Gemini CLI; a Claude Code plugin is included |
| **[Other CI](docs/integrations/other-ci.md)** | GitLab, Bitbucket Pipelines, Azure DevOps, Docker and Dagger |
| **[A2A](docs/integrations/a2a.md)** | An Agent2Agent card and endpoint so other agents can delegate to it |
| **[MCP server](docs/integrations/mcp-server.md)** | Give your editor or agent a safe way to fix dependencies |
| **[HTTP server](docs/integrations/http-server.md)** | Call it from internal services |
| **[VS Code](packages/vscode-extension/README.md)** | Findings and one-click fixes in `package.json` |

Beyond fixing a CVE: assemble a [CRA evidence pack](docs/guides/evidence-pack.md), have a model write and prove an [exploit reproduction](docs/guides/proof-of-fix-generation.md), spot [silent security fixes](docs/guides/silent-fix-radar.md), keep dependencies [fresh](docs/guides/freshness.md) in small verified steps, and compile rules into a [policy](docs/guides/policy-in-plain-language.md). Also: [guard](docs/guides/guard.md) packages before an agent installs them, [diet](docs/guides/dependency-diet.md) what you depend on, [bisect](docs/guides/bisect.md) a broken lockfile, respond to a [compromised package](docs/guides/incident-response.md), and let a repository [earn autonomy](docs/guides/earned-autonomy.md).

Works with npm, pnpm, Yarn, Bun and Deno projects. Requires Node.js 26 or later.

> [!WARNING]
> Automated dependency changes carry operational and supply-chain risk. Start with `--dry-run`, keep
> CI and branch protection in place, and set a policy. See [Safety](docs/safety.md).

## Learn more

[Getting started](docs/getting-started.md) · [How it works](docs/how-it-works.md) ·
[CLI](docs/reference/cli.md) · [All documentation](docs/README.md) ·
[Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
