# Autoremediator

[![npm version](https://img.shields.io/npm/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![npm downloads](https://img.shields.io/npm/dm/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![license](https://img.shields.io/npm/l/autoremediator.svg)](LICENSE)
[![node](https://img.shields.io/node/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://github.com/Rawlings/autoremediator/pkgs/container/autoremediator)
[![GitHub Actions](https://img.shields.io/badge/github--actions-marketplace-blue)](https://github.com/marketplace/actions/autoremediator)

> [!WARNING]
> Automated dependency remediation carries operational and supply-chain risk if deployed without policy controls.
> Autoremediator is designed for risk-aware security and platform teams, and should be paired with explicit remediation policy, CI validation gates, and repository protection rules.

Autoremediator is an agentic CVE remediation platform for Node.js.

It closes the gap between vulnerability detection and remediation by correlating threat intelligence, measuring exploitability, and executing policy-governed fixes — across single repositories, large service portfolios, and agent-driven workflows.

The outcome is reduced mean time to remediation (MTTR), narrower exposure windows, and auditable remediation posture across your dependency estate.

See the [documentation](https://rawlings.github.io/autoremediator/docs/getting-started) to get started.

## A remediation control plane, not a scanner

Most SCA tools stop at detection. Autoremediator starts there.

It ingests vulnerability findings from scanners or accepts a CVE ID directly, then drives each finding through a multi-strategy remediation pipeline: safe version upgrade, transitive dependency override, and controlled patch generation with confidence scoring as a last resort. Every path is gated by policy, validated before it is applied, and backed by structured evidence for downstream traceability.

The result is a closed-loop remediation workflow rather than an ever-growing triage backlog.

## Exploitability-informed prioritization

Severity scores alone are poor remediation signals. Autoremediator enriches each CVE with corroborating signals before any fix is attempted:

- **CISA KEV** — confirms whether a vulnerability is actively exploited in the wild
- **EPSS** — quantifies exploit probability as a continuous percentile score
- **Advisory consensus** — cross-references OSV, GitHub Advisory Database, and NVD to validate affected ranges and fixed versions

This enrichment drives prioritization and disposition decisions, so high-risk, actively exploited vulnerabilities are handled with higher urgency than theoretical severities would suggest.

## Multi-strategy remediation

Autoremediator selects the safest applicable fix strategy for each vulnerability:

- **Direct version upgrade** — the preferred path when a safe fixed version exists in the direct dependency graph
- **Transitive override** — applied when exposure is in a transitive dependency and a direct upgrade is not feasible
- **Controlled patch generation** — a confidence-scored fallback when no safe fixed version exists; produces auditable patch artifacts tracked through their full lifecycle

Unresolved findings are never silently dropped. Each one is classified with an explicit reason and treated as an escalation input for downstream security workflows.

## Policy-governed automation

Autoremediator is designed to operate autonomously without sacrificing control. Remediation behavior is governed by a policy layer that determines disposition for every finding:

- **Auto-apply** for high-confidence remediations within acceptable risk thresholds
- **Simulation** for preview and dry-run validation before mutations are committed
- **Hold for approval** when human review is warranted before applying a fix
- **Escalation** for findings that exceed risk tolerance, with configurable follow-on actions such as issue creation, channel notification, or draft PR

Portfolio-scale campaigns apply risk ranking to prioritize remediation order across large target sets.

## Vulnerability intelligence sources

Primary advisory sources:

- [OSV](https://osv.dev): ecosystem-first vulnerability records and affected or fixed ranges
- [GitHub Advisory Database](https://github.com/advisories): package advisories and ecosystem metadata
- [NVD](https://nvd.nist.gov): CVE reference data and severity context

Exploitability and trust enrichment:

- [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog): active exploitation signals
- [FIRST EPSS](https://www.first.org/epss/): exploit probability scoring
- [CVE Services](https://www.cve.org/): authoritative CVE references
- [GitLab Advisory Database](https://advisories.gitlab.com): supplemental advisory coverage
- [CERT/CC Vulnerability Notes](https://www.kb.cert.org/vuls/): analyst context for selected CVEs
- [deps.dev](https://deps.dev): package metadata and dependency graph coverage
- [OpenSSF Scorecard](https://securityscorecards.dev): repository and package trust posture
- Optional vendor and commercial feeds via environment-configured connectors

## Integration surfaces

Autoremediator is designed to meet security operations where they already run:

- **CLI** — direct invocation in developer workflows and CI/CD pipeline jobs
- **SDK** — programmatic integration for platforms, internal tooling, and security automation
- **GitHub Actions** — reusable workflow and Marketplace action for scan-to-remediation CI pipelines
- **MCP server** — native tool integration for AI agents, LLM orchestrators, and copilot surfaces
- **OpenAPI server** — HTTP-accessible remediation endpoint for centralized or service-based deployments
- **VS Code extension** — editor-side vulnerability scanning and fix actions

```yaml
jobs:
  gate:
    uses: rawlings/autoremediator/.github/workflows/reusable-remediate-from-audit.yml@v1
    with:
      audit: true
      dry-run: true
      ci: true
```

For configuration reference, workflow variants, and MCP host setup, see the [Integrations](https://rawlings.github.io/autoremediator/docs/integrations) and [Agent Ecosystems](https://rawlings.github.io/autoremediator/docs/agent-ecosystems) guides.

## Use cases

- Autonomous vulnerability remediation in CI/CD pipelines with deterministic security gating
- Continuous exposure reduction across large Node.js service portfolios
- Scanner-to-remediation conversion for high-volume SCA findings
- Embedded remediation for internal security platforms, AI assistants, and SecOps tooling
- Policy-governed supply chain risk management at scale

## Documentation

- [Docs Home](https://rawlings.github.io/autoremediator/)
- [Getting Started](https://rawlings.github.io/autoremediator/docs/getting-started): setup, first run, and result interpretation
- [CLI Reference](https://rawlings.github.io/autoremediator/docs/cli): commands, options, and CI semantics
- [Scanner Inputs](https://rawlings.github.io/autoremediator/docs/scanner-inputs): supported formats and parsing constraints
- [Policy and Safety](https://rawlings.github.io/autoremediator/docs/policy-and-safety): policy precedence, safeguards, and fallback controls
- [API and SDK](https://rawlings.github.io/autoremediator/docs/api-sdk): programmatic integration and CI summary utilities
- [Integrations](https://rawlings.github.io/autoremediator/docs/integrations): GitHub Actions, MCP, OpenAPI, and multi-stage pipelines
- [Agent Ecosystems](https://rawlings.github.io/autoremediator/docs/agent-ecosystems): MCP host setup and orchestration examples
- [Contributor Guide](https://rawlings.github.io/autoremediator/docs/contributor-guide): architecture and contribution standards

## Project References

- [Contributing](CONTRIBUTING.md)
- [Agent Modes](AGENTS.md)
- [LLM Context Summary](llms.txt)

## License

MIT
