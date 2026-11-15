---
"autoremediator": minor
---

Autoremediator becomes an agent-first remediation platform: agents propose, a deterministic verifier decides, git remembers.

- **One operation catalog** generates the MCP tools, HTTP routes and OpenAPI, SDK and CLI options, so they cannot drift.
- **Runs:** plan, apply, resume, roll back and verify, recorded on disk, with a verifier that checks scope, policy, supply chain, install, the vulnerability, types, tests and proof of fix.
- **Agent repair:** a built-in agent, or your own host agent over MCP, repairs upgrades that break the project; the verifier accepts or rejects. MCP now returns structured results and offers resources, prompts, host-driven attempts and an HTTP transport.
- **Setup and integration:** `init` for Claude Code, Cursor, VS Code, Codex, Gemini and Copilot, a Claude Code plugin, git hooks, an A2A agent card, and GitLab, Bitbucket, Azure DevOps, Docker and Dagger support.
- **Dependency safety:** `guard` checks a package before an agent installs it; also upgrade impact, silent-fix radar, incident response and pre-mortems, lockfile bisect, dependency diet, freshness, runtime reachability, and maintainer-shipped VEX.
- **Evidence and autonomy:** a CRA evidence pack, generated and sandbox-proven exploit reproductions, earned autonomy levels, recipes, remediation memory, and policy written in plain language.
- **Fixes:** every installed copy of a package is tracked, suppressions reach VEX and the SBOM, registries come from `.npmrc`, version choice skips risky releases, overrides work on pnpm 11+, and pnpm 12 lockfiles parse.

Breaking: MCP and HTTP arguments are validated strictly, change-request credentials cannot be passed remotely, path arguments are confined to allowed roots, `--ci` exit codes distinguish partial (2), approval needed (3) and policy-blocked (4), change-request branch names are deterministic, a project `.npmrc` cannot expand ambient secrets for unknown registries, and `compilePolicy` and `radar` now need the operator role.
