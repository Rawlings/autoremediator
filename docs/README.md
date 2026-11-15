# Documentation

Start with [Getting started](getting-started.md), then [How it works](how-it-works.md). The rest is
organized by what you are trying to do.

## Learn

- [Getting started](getting-started.md): install, first dry run, applying a fix
- [How it works](how-it-works.md): fix strategies, verification, outcomes
- [Safety](safety.md): guarantees, trust boundaries, network access

## Guides

- [Scanners and inputs](guides/scanners.md): audit output, SARIF, git diffs, portfolios
- [Automation and CI](guides/automation.md): exit codes, report formats, pull requests and re-runs
- [Git hooks](guides/git-hooks.md): block a push that makes your dependencies less safe (husky, lefthook, pre-commit, plain git)
- [Earned autonomy](guides/earned-autonomy.md): a repository's level, from its own verified record
- [Recipes](guides/recipes.md): keep what an agent repair learned as data
- [Runtime reachability](guides/runtime-reachability.md): record what your tests load and call
- [Upgrade impact](guides/upgrade-impact.md): assess an upgrade against your own usage; candidate vulnerable symbols
- [Incident response](guides/incident-response.md): when a package is compromised, and pre-mortems
- [Lockfile bisect](guides/bisect.md): find which dependency update broke a command
- [Dependency diet](guides/dependency-diet.md): unused, replaceable and duplicate dependencies
- [Evidence pack](guides/evidence-pack.md): CRA-oriented SBOM, VEX, report drafts and signed attestations
- [Exploit-proof evidence](guides/proof-of-fix-generation.md): reproductions an agent writes and the harness proves
- [Silent-fix radar](guides/silent-fix-radar.md): security-relevant releases before an advisory exists
- [Maintainer VEX](guides/maintainer-vex.md): verdicts shipped inside packages
- [Freshness](guides/freshness.md): small verified steps toward the latest versions
- [Memory](guides/memory.md): what a repository remembers between runs
- [Policy in plain language](guides/policy-in-plain-language.md): compile rules into a reviewable policy diff
- [Guarding new dependencies](guides/guard.md): checking a package before an agent installs it
- [Plan, apply and roll back](guides/plan-and-apply.md): reviewing a fix first, resuming, undoing
- [Patch generation](guides/patch-generation.md): letting a model write a patch
- [Offline use](guides/offline.md): intelligence sources and snapshots

## Reference

- [CLI](reference/cli.md): commands and flags
- [SDK](reference/sdk.md): functions, options, reports
- [Policy file](reference/policy-file.md): `.github/autoremediator.yml`
- [Environment variables](reference/environment.md)

## Integrations

- [GitHub Action](integrations/github-action.md)
- [GitHub App](integrations/github-app.md)
- [GitLab, Bitbucket, Azure DevOps, Docker, Dagger](integrations/other-ci.md)
- [Coding agents](integrations/coding-agents.md): `init`, Claude Code plugin, Cursor, VS Code, Copilot, Codex, Gemini
- [MCP server](integrations/mcp-server.md)
- [A2A](integrations/a2a.md): agent card and Agent2Agent endpoint so other agents can discover and delegate to Autoremediator
- [HTTP server](integrations/http-server.md)
- [VS Code extension](../packages/vscode-extension/README.md)

## Releases

- [Changelog](../packages/core/CHANGELOG.md): what changed in each version, including breaking changes

## Contributing

- [Contributing guide](../CONTRIBUTING.md)
- [Benchmark](contributing/benchmark.md): tasks, modes, scoring, adding a task
- [Architecture](contributing/architecture.md)
- [Security policy](../.github/SECURITY.md)
