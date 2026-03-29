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

- Continuous remediation in CI and scheduled GitHub workflows
- Risk-aware prioritization using EPSS, CISA KEV, and OSV intelligence
- Scanner-to-fix pipelines from npm audit, yarn audit, and SARIF inputs
- Lower vulnerability fatigue by focusing operator attention on exploited and higher-probability issues
- Policy-aware upgrade behavior for controlled automation at scale
- Structured evidence and summary outputs for security operations
- Multiple integration surfaces for platform engineering and automation agents

## Primary Use Cases

- Scheduled GitHub Actions remediation jobs with auto-generated pull requests
- CI enforcement gates that fail on unresolved remediation outcomes
- Scanner-to-fix automation from npm audit, yarn audit, and SARIF outputs
- Platform-level remediation orchestration across many services
- Agentic integration via CLI, SDK, MCP, and OpenAPI

## How Remediation Works

Core pipeline behavior:

1. CVE lookup and enrichment
2. installed dependency inventory detection
3. vulnerable version matching
4. safe version bump attempt
5. controlled fallback patch flow when no safe bump exists

Safety and policy controls are applied through each stage.

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
- MCP: AI host integrations
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
