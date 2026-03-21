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

## Why Teams Use It

- Continuous remediation in CI and scheduled GitHub workflows
- Scanner-to-fix pipelines from npm audit, yarn audit, and SARIF inputs
- Policy-aware upgrade behavior for controlled automation at scale
- Structured evidence and summary outputs for security operations
- Multiple integration surfaces for platform engineering and automation agents

## Primary Use Cases

- GitHub workflow automation: nightly or hourly remediation runs that open PRs automatically
- CI enforcement: fail builds when unresolved vulnerabilities remain after remediation attempts
- Security operations acceleration: convert scanner outputs into actionable remediation changes
- Platform integration: embed remediation in internal bots and security assistants via SDK, MCP, or OpenAPI
- Portfolio remediation: standardize CVE handling across many Node.js services

## Surfaces

- CLI for workflow jobs and CI runs
- SDK for custom automation programs
- MCP for AI tooling ecosystems
- OpenAPI for service-based integration

## Documentation

- https://rawlings.github.io/autoremediator/

- Getting Started: https://rawlings.github.io/autoremediator/docs/getting-started
- CLI Reference: https://rawlings.github.io/autoremediator/docs/cli
- Scanner Inputs: https://rawlings.github.io/autoremediator/docs/scanner-inputs
- Policy and Safety: https://rawlings.github.io/autoremediator/docs/policy-and-safety
- API and SDK: https://rawlings.github.io/autoremediator/docs/api-sdk
- Integrations: https://rawlings.github.io/autoremediator/docs/integrations
- Contributor Guide: https://rawlings.github.io/autoremediator/docs/contributor-guide

## Product Direction

- Prioritize automation workflows over one-off manual runs
- Configure policy and branch protection before broad rollout
- Use CI summaries and evidence outputs for operational governance

## Getting Started Fast

Start from the live guides instead of repo markdown:

- Quick setup: https://rawlings.github.io/autoremediator/docs/getting-started
- Automation workflows: https://rawlings.github.io/autoremediator/docs/integrations
- Safety controls: https://rawlings.github.io/autoremediator/docs/policy-and-safety

## Project References

- [Contributing](CONTRIBUTING.md)
- [Agent Modes](AGENTS.md)
- [LLM Context Summary](llms.txt)

## License

MIT
