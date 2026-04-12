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

Autoremediator is an agentic CVE remediation platform for Node.js.

It turns dependency security from fragmented backlog triage into an autonomous remediation pipeline with threat-intelligence correlation, exploitability-aware prioritization, deterministic execution, and machine-readable evidence.

It is built for AI-native software delivery, agentic security operations, and policy-governed software supply chain response.

The outcome is faster containment of dependency exposure, stronger remediation posture, and cleaner telemetry across CI/CD, platform automation, and agent-driven workflows.

See the [documentation](https://rawlings.github.io/autoremediator/docs/getting-started) to get started.

## Security remediation, closed loop

Autoremediator operates as a remediation control plane, not a scanner wrapper.

It correlates ecosystem advisory data, exploitability telemetry, and operational policy to drive remediation decisions across repositories, portfolios, service surfaces, and agentic execution paths.

When a clean upgrade path exists, it executes a safe dependency bump. When exposure is transitive, it applies package-manager-native overrides and resolutions. When no safe fixed version exists, it escalates into controlled patch generation with confidence thresholds, validation gates, and artifact tracking.

Every remediation path is constrained by policy, dry-run controls, validation requirements, and auditable evidence artifacts so autonomous response stays governable, reviewable, and automation-safe.

## What sets it apart

- Exploit-aware prioritization beyond severity-centric triage
- Deterministic remediation orchestration with explicit safety and failure semantics
- Multi-strategy execution across direct bumps, transitive overrides, and controlled patch fallback
- Portfolio-scale coverage across large Node.js repository estates
- AI ecosystem interoperability through MCP, OpenAPI, SDK, CLI, and agent runtime surfaces
- Structured evidence, rollups, outcome taxonomy, and agent-consumable telemetry for governance and security analytics

## From signal to remediation

Canonical remediation flow:

1. lookup CVE intelligence
2. inspect installed dependency inventory
3. match vulnerable installed versions
4. attempt safe direct dependency version bump
5. if transitive, attempt package-manager-native override or resolution
6. if still unresolved, attempt controlled patch fallback and emit patch artifacts

Outputs remain deterministic across interfaces, including `strategyCounts`, `dependencyScopeCounts`, and `unresolvedByReason`, so CI systems, workflow engines, autonomous agents, and orchestration runtimes can route outcomes without reparsing nested result trees.

Patch artifacts are written to `patchesDir` with `.patch.json` manifests and can be listed, inspected, and validated in follow-on automation.

## Intelligence that drives action

Primary sources:

- [OSV](https://osv.dev): ecosystem-first vulnerability records and affected or fixed ranges
- [GitHub Advisory Database](https://github.com/advisories): package advisories and ecosystem metadata
- [NVD](https://nvd.nist.gov): severity context and CVE reference data

Enrichment and prioritization sources:

- [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog): known-exploited vulnerability signal
- [FIRST EPSS](https://www.first.org/epss/): exploit probability and percentile scoring
- [CVE Services](https://www.cve.org/): additional CVE references and descriptions
- [GitLab Advisory Database](https://advisories.gitlab.com): supplemental advisory matching
- [CERT/CC Vulnerability Notes](https://www.kb.cert.org/vuls/): analyst context for selected CVEs
- [deps.dev](https://deps.dev): package metadata coverage checks
- [OpenSSF Scorecard](https://securityscorecards.dev): package trust and repository posture signals
- Optional vendor and commercial feeds via environment-configured connectors

Trust model principles:

- Correlate across multiple advisory, exploitability, and trust sources
- Preserve evidence so remediation decisions remain auditable
- Enforce policy and validation gates before outcomes are marked resolved
- Treat low-confidence or unresolved outcomes as explicit escalation inputs

## Built for every surface

- CLI: workflow jobs and CI runs
- SDK: `remediate`, `planRemediation`, `remediateFromScan`
- MCP server: agent ecosystem integration, tool invocation, and LLM-orchestrated workflows
- OpenAPI server: service-based integration and centralized remediation operations
- VS Code extension: Node CVE Remediator for editor-side scanning and fix actions

Patch lifecycle operations are exposed consistently:

- CLI: `autoremediator patches list`, `autoremediator patches inspect`, `autoremediator patches validate`
- SDK: `listPatchArtifacts`, `inspectPatchArtifact`, `validatePatchArtifact`
- MCP and OpenAPI: equivalent patch lifecycle operations

GitHub Actions quick start:

```yaml
jobs:
  gate:
    uses: rawlings/autoremediator/.github/workflows/reusable-remediate-from-audit.yml@v1
    with:
      audit: true
      dry-run: true
      ci: true
```

The reusable workflow wraps the Marketplace action and supports optional PR creation plus summary artifact upload.
For release tags, detailed input reference, and template variants, see the Integrations guide.

## Designed for agentic workflows

Recommended orchestration flow:

1. call `planRemediation` to generate a non-mutating plan
2. apply `remediate` after policy and approval checks
3. inspect and validate patch artifacts when fallback patching occurs

Public naming canon across surfaces: `runTests`, `policy`, `evidence`, `patchCount`, `patchesDir`.

Native change-request support includes GitHub and GitLab workflows, including grouped scan strategies, orchestration-friendly run metadata, and plan-first execution patterns for agentic systems.

Packaging shortcut: `pnpm build:vsix` builds the publishable VSIX from the repository root.

## Use cases

- Autonomous security automation in GitHub workflows and CI/CD pipelines
- Deterministic CI gating for unresolved dependency exposure
- Scanner-to-remediation conversion for high-volume vulnerability backlogs
- Embedded remediation for internal AI assistants, copilots, bots, and security platforms
- Portfolio-wide standardization across large Node.js service estates

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
