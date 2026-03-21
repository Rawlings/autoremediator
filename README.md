# Autoremediator

[![npm version](https://img.shields.io/npm/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![npm downloads](https://img.shields.io/npm/dm/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![license](https://img.shields.io/npm/l/autoremediator.svg)](LICENSE)
[![node](https://img.shields.io/node/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)

> [!WARNING]
> Automated dependency remediation is a controversial practice.
> It can reduce exposure windows, but it can also introduce operational and supply-chain risk if used without policy controls.
> Autoremediator is designed for automation-first teams, and should be paired with explicit policy, CI safeguards, and repository protection rules.

Autoremediator is an automation-first Node.js CVE remediation platform.

It is built for teams that want dependency remediation to run as part of delivery infrastructure, not as ad hoc manual activity.

It supports direct CVE remediation, scanner-driven batch remediation, deterministic CI gating, and service/agent integrations (SDK, MCP, OpenAPI).

## Why Teams Use It

- Continuous remediation in CI and scheduled GitHub workflows
- Scanner-to-fix pipelines from npm audit, yarn audit, and SARIF inputs
- Policy-aware upgrade behavior for controlled automation at scale
- Structured evidence and summary outputs for security operations
- Multiple integration surfaces for platform engineering and automation agents

## How It Works

Autoremediator follows a deterministic remediation flow:

1. lookup CVE intelligence
2. inspect installed dependency inventory
3. match vulnerable installed versions
4. attempt safe version bump
5. if no safe bump exists, attempt controlled patch fallback

Safety gates are applied throughout the flow, including policy enforcement, dry-run controls, and validation requirements.

## Trust and Advisory Sources

Autoremediator is built around verifiable vulnerability intelligence from public advisory sources.

Primary sources used by the remediation pipeline:

- [OSV](https://osv.dev): ecosystem-first vulnerability records and affected/fixed range data
- [GitHub Advisory Database](https://github.com/advisories): package advisories with ecosystem metadata
- [NVD](https://nvd.nist.gov): NIST-backed CVE reference data and severity context

Trust model principles:

- use multiple sources for CVE enrichment and correlation
- preserve evidence output so remediation decisions can be audited
- apply policy and validation gates before marking outcomes resolved
- treat unresolved or low-confidence outcomes as explicit escalation paths

## Primary Use Cases

- GitHub workflow automation: nightly or hourly remediation runs that open PRs automatically
- CI enforcement: fail builds when unresolved vulnerabilities remain after remediation attempts
- Security operations acceleration: convert scanner outputs into actionable remediation changes
- Platform integration: embed remediation in internal bots and security assistants via SDK, MCP, or OpenAPI
- Portfolio remediation: standardize CVE handling across many Node.js services

## Security and Automation Principles

- keep automation policy-driven (`.autoremediator.json`)
- use dry-run first in new repositories
- retain summaries/evidence for audit trails
- require review and branch protection for remediation PRs
- treat unresolved outcomes as escalation inputs

## Surfaces

- CLI for workflow jobs and CI runs
- SDK for custom automation programs
- MCP for AI tooling ecosystems
- OpenAPI for service-based integration

## Documentation

- [Docs Home](https://rawlings.github.io/autoremediator/)
- [Getting Started](https://rawlings.github.io/autoremediator/docs/getting-started): setup, first runs, and result interpretation
- [CLI Reference](https://rawlings.github.io/autoremediator/docs/cli): command modes, option semantics, and CI behavior
- [Scanner Inputs](https://rawlings.github.io/autoremediator/docs/scanner-inputs): scanner format support and parsing constraints
- [Policy and Safety](https://rawlings.github.io/autoremediator/docs/policy-and-safety): policy precedence, safety guarantees, and fallback controls
- [API and SDK](https://rawlings.github.io/autoremediator/docs/api-sdk): programmatic integration and CI summary utilities
- [Integrations](https://rawlings.github.io/autoremediator/docs/integrations): GitHub Actions, MCP, OpenAPI, and multi-stage automation patterns
- [Contributor Guide](https://rawlings.github.io/autoremediator/docs/contributor-guide): architecture and contribution standards

## Product Direction

- Prioritize automation workflows over one-off manual runs
- Configure policy and branch protection before broad rollout
- Use CI summaries and evidence outputs for operational governance

## Getting Started Fast

Start from the live guides instead of repo markdown:

- [Quick setup](https://rawlings.github.io/autoremediator/docs/getting-started)
- [Automation workflows](https://rawlings.github.io/autoremediator/docs/integrations)
- [Safety controls](https://rawlings.github.io/autoremediator/docs/policy-and-safety)

## Project References

- [Contributing](CONTRIBUTING.md)
- [Agent Modes](AGENTS.md)
- [LLM Context Summary](llms.txt)

## License

MIT
