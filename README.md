# Autoremediator

[![npm version](https://img.shields.io/npm/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![npm downloads](https://img.shields.io/npm/dm/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![license](https://img.shields.io/npm/l/autoremediator.svg)](LICENSE)
[![node](https://img.shields.io/node/v/autoremediator.svg)](https://www.npmjs.com/package/autoremediator)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://github.com/Rawlings/autoremediator/pkgs/container/autoremediator)
[![GitHub Actions](https://img.shields.io/badge/github--actions-marketplace-blue)](https://github.com/marketplace/actions/autoremediator)

> [!WARNING]
> Automated dependency remediation is a controversial practice.
> It can reduce exposure windows, but it can also introduce operational and supply-chain risk if used without policy controls.
> Autoremediator is designed for risk-aware automation teams, and should be paired with explicit policy, CI safeguards, and repository protection rules.

Autoremediator is a risk-aware, agentic CVE remediation platform for Node.js.

It correlates OSV package intelligence with CISA KEV known-exploited signals and FIRST EPSS exploit probability scores so teams can prioritize vulnerabilities that are more likely to matter in production.

It is built for teams that want security remediation to run as part of delivery infrastructure, not as ad hoc manual activity or semver-only triage.

It supports direct CVE remediation, scanner-driven batch remediation, deterministic CI gating, and service/agent integrations (SDK, MCP, OpenAPI).

It is standards-first and interoperable with major agent ecosystems through MCP and OpenAPI, including common MCP hosts, Claude Mythos workflows, and custom automation runtimes.

It also supports non-mutating remediation planning and run-correlation metadata for orchestration-first platforms.

Safety and trust are built in through policy gates, dry-run controls, validation requirements, and structured evidence outputs.

Scan and CI summaries include rollups for remediation strategy, dependency scope, and unresolved reasons so downstream automation can distinguish direct upgrades from transitive override outcomes without reparsing nested result trees.

See the [documentation](https://rawlings.github.io/autoremediator/docs/getting-started) to get started.

## Why Teams Use It

- Deterministic remediation flow aligned to policy-first operations
- Risk-informed prioritization with KEV and EPSS enrichment
- Scanner-to-remediation automation for batch workflows
- Cross-surface integration via CLI, SDK, MCP, and OpenAPI
- Structured evidence and CI summaries for governance and routing
- Patch lifecycle workflows for listing, inspecting, and validating generated patch artifacts

## How It Works

Autoremediator follows a deterministic, risk-informed remediation flow:

1. lookup CVE intelligence
2. inspect installed dependency inventory
3. match vulnerable installed versions
4. attempt a safe direct dependency version bump
5. when the vulnerable package is transitive, attempt a package-manager-native override or resolution
6. if neither path can remediate safely, attempt controlled patch fallback and emit a patch artifact manifest

Safety gates are applied throughout the flow, including policy enforcement, dry-run controls, and validation requirements.

Patch artifacts are stored in `patchesDir` and include `.patch.json` manifests that can be inspected and validated by follow-up automation.

Operational outputs stay deterministic across CLI, SDK, MCP, and OpenAPI surfaces, including `strategyCounts`, `dependencyScopeCounts`, and `unresolvedByReason` for CI routing and dashboards.

Patch lifecycle operations are available through:

- CLI: `autoremediator patches list`, `autoremediator patches inspect`, `autoremediator patches validate`
- SDK: `listPatchArtifacts`, `inspectPatchArtifact`, `validatePatchArtifact`
- MCP and OpenAPI: equivalent patch artifact tools and routes

## Trust and Advisory Sources

Primary sources:

- [OSV](https://osv.dev): ecosystem-first vulnerability records and affected/fixed range data
- [GitHub Advisory Database](https://github.com/advisories): package advisories with ecosystem metadata
- [NVD](https://nvd.nist.gov): NIST-backed CVE reference data and severity context

Supplemental enrichment and prioritization sources:

- [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog): known exploited vulnerability signal
- [FIRST EPSS](https://www.first.org/epss/): exploit probability and percentile scoring
- [CVE Services](https://www.cve.org/): additional CVE record references and descriptions
- [GitLab Advisory Database](https://advisories.gitlab.com): supplemental advisory matching and references
- [CERT/CC Vulnerability Notes](https://www.kb.cert.org/vuls/): additional analyst context for selected CVEs
- [deps.dev](https://deps.dev): package metadata coverage checks
- [OpenSSF Scorecard](https://securityscorecards.dev): package trust and repository security posture signals
- Optional vendor and commercial feeds via environment-configured connectors

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
- SDK for custom automation programs (`remediate`, `planRemediation`, `remediateFromScan`)
- MCP for AI tooling ecosystems and other MCP hosts
- OpenAPI for service-based integration and centralized remediation services
- VS Code extension: Node CVE Remediator for editor-side scanning and fix actions

### Agent Workflow Pattern

Recommended plan-first flow for agent orchestration:

1. call `planRemediation` to produce a non-mutating plan
2. call `remediate` only after policy and approval checks
3. inspect and validate patch artifacts when fallback patching was used

Public API naming canon: `runTests`, `policy`, `evidence`, `patchCount`, and `patchesDir`.

Packaging shortcut: `pnpm build:vsix` builds the publishable VSIX from the repository root.

## Documentation

- [Docs Home](https://rawlings.github.io/autoremediator/)
- [Getting Started](https://rawlings.github.io/autoremediator/docs/getting-started): setup, first runs, and result interpretation
- [CLI Reference](https://rawlings.github.io/autoremediator/docs/cli): command modes, option semantics, and CI behavior
- [Scanner Inputs](https://rawlings.github.io/autoremediator/docs/scanner-inputs): scanner format support and parsing constraints
- [Policy and Safety](https://rawlings.github.io/autoremediator/docs/policy-and-safety): policy precedence, safety guarantees, and fallback controls
- [API and SDK](https://rawlings.github.io/autoremediator/docs/api-sdk): programmatic integration and CI summary utilities
- [Integrations](https://rawlings.github.io/autoremediator/docs/integrations): GitHub Actions, MCP, OpenAPI, and multi-stage automation patterns
- [Agent Ecosystems](https://rawlings.github.io/autoremediator/docs/agent-ecosystems): MCP host setup examples and plan-first orchestration flows
- [Contributor Guide](https://rawlings.github.io/autoremediator/docs/contributor-guide): architecture and contribution standards

## Product Direction

- Prioritize automation workflows over one-off manual runs
- Configure policy and branch protection before broad rollout
- Use CI summaries and evidence outputs for operational governance

## Project References

- [Contributing](CONTRIBUTING.md)
- [Agent Modes](AGENTS.md)
- [LLM Context Summary](llms.txt)

## License

MIT
