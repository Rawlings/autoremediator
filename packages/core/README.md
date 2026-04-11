# Autoremediator

[![npm version](https://img.shields.io/npm/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![npm downloads](https://img.shields.io/npm/dm/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![license](https://img.shields.io/npm/l/autoremediator.svg)](https://github.com/Rawlings/autoremediator/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://github.com/Rawlings/autoremediator/pkgs/container/autoremediator)
[![GitHub Actions](https://img.shields.io/badge/github--actions-marketplace-blue)](https://github.com/marketplace/actions/autoremediator)

> [!WARNING]
> Automated dependency remediation is a controversial practice.
> It can reduce exposure windows, but it can also introduce operational and supply-chain risk if used without policy controls.
> Autoremediator is designed for risk-aware automation teams, and should be paired with explicit policy, CI safeguards, and repository protection rules.

Autoremediator is a risk-aware, agentic Node.js CVE remediation package.

It correlates OSV package intelligence with CISA KEV known-exploited signals and FIRST EPSS exploit probability scores to prioritize vulnerabilities more likely to matter in production.

This package is designed for teams that want remediation integrated into GitHub workflows and CI pipelines with policy and evidence controls.

It exposes stable SDK and CLI surfaces for direct CVE remediation and scanner-driven automation.

It also exposes non-mutating planning and correlation context for agent orchestration workflows.

See the [documentation](https://rawlings.github.io/autoremediator/docs/getting-started) to get started.

## Why Teams Use It

- Deterministic remediation pipeline with policy-first behavior
- Risk-informed prioritization via KEV and EPSS enrichment
- Scanner-driven remediation for npm audit, yarn audit, and SARIF inputs
- Clear CI summary outputs for routing and governance
- Patch lifecycle workflows for listing, inspecting, and validating generated patch artifacts

## Primary Use Cases

- Scheduled GitHub Actions remediation jobs with auto-generated pull requests
- CI enforcement gates that fail on unresolved remediation outcomes
- Scanner-to-fix automation from npm audit, yarn audit, and SARIF outputs
- Platform-level remediation orchestration across many services
- Agentic integration via CLI, SDK, MCP, and OpenAPI

## Core Pipeline Behavior

Autoremediator follows a deterministic remediation order:

1. lookup CVE intelligence
2. inspect local dependency inventory
3. match vulnerable installed versions
4. attempt direct safe version remediation
5. attempt transitive override/resolution when direct bump is not possible
6. attempt patch fallback only when safe version paths cannot remediate

Safety and policy controls are applied through each stage.

Patch lifecycle operations are available through:

- CLI: `autoremediator patches list`, `autoremediator patches inspect`, `autoremediator patches validate`
- SDK: `listPatchArtifacts`, `inspectPatchArtifact`, `validatePatchArtifact`
- MCP and OpenAPI: equivalent patch artifact tools and routes

## Trust and Advisory Sources

The remediation engine relies on public vulnerability intelligence sources and deterministic policy checks.

Primary sources:

- [OSV](https://osv.dev)
- [GitHub Advisory Database](https://github.com/advisories)
- [NVD](https://nvd.nist.gov)

Supplemental enrichment and prioritization sources:

- [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)
- [FIRST EPSS](https://www.first.org/epss/)
- [CVE Services](https://www.cve.org/)
- [GitLab Advisory Database](https://advisories.gitlab.com)
- [CERT/CC Vulnerability Notes](https://www.kb.cert.org/vuls/)
- [deps.dev](https://deps.dev)
- [OpenSSF Scorecard](https://securityscorecards.dev)
- Optional vendor and commercial feeds via environment-configured connectors

Trust controls:

- correlate advisory data with local dependency inventory before action
- prefer safe version remediation when fixed versions are available
- emit structured evidence so every remediation attempt is traceable
- preserve unresolved status when confidence or validation gates fail

## Surfaces

- CLI: workflow and CI execution
- SDK: custom automation programs (`remediate`, `planRemediation`, `remediateFromScan`)
- MCP: AI host integrations, including Claude Mythos workflows
- OpenAPI: service-based automation

Public API naming canon: `runTests`, `policy`, `evidence`, `patchCount`, and `patchesDir`.

## Documentation

- [Docs Home](https://rawlings.github.io/autoremediator/)
- [Getting Started](https://rawlings.github.io/autoremediator/docs/getting-started): install and first remediation runs
- [CLI Reference](https://rawlings.github.io/autoremediator/docs/cli): command and option semantics
- [Scanner Inputs](https://rawlings.github.io/autoremediator/docs/scanner-inputs): scanner adapters and format constraints
- [Policy and Safety](https://rawlings.github.io/autoremediator/docs/policy-and-safety): policy precedence and operational guardrails
- [API and SDK](https://rawlings.github.io/autoremediator/docs/api-sdk): public programmatic entry points
- [Integrations](https://rawlings.github.io/autoremediator/docs/integrations): CI workflows and service integrations
- [Contributor Guide](https://rawlings.github.io/autoremediator/docs/contributor-guide): architecture and extension guidance

## Product Direction

- Prioritize automation workflows over one-off manual runs
- Configure policy and branch protection before broad rollout
- Use CI summaries and evidence outputs for operational governance

## Package

- [npm package](https://www.npmjs.com/package/autoremediator)
- [repository](https://github.com/Rawlings/autoremediator)

## License

MIT
