# Contributor Guide

This guide explains what contributors should change, why the project is structured this way, and how to extend documentation and runtime behavior safely.

Related references:

- [Getting Started](getting-started.md)
- [Policy and Safety](policy-and-safety.md)
- [Integrations](integrations.md)

## Documentation Architecture

Documentation is intentionally split by audience and depth:

- root [README](../../README.md): product-level overview and entry links
- [packages/docs/content](.): detailed operator and contributor references
- [.github/instructions](../../.github/instructions): governance constraints for agent/runtime behavior
- [.github/skills](../../.github/skills): scoped implementation patterns

Why this split exists: operational users need concise how-to references, while contributors need governance and architecture context.

## Runtime Architecture Overview

Core runtime is in `packages/core/src` with feature-first modules:

- `platform`: policy, evidence, types, config
- `intelligence`: CVE source acquisition and enrichment
- `scanner`: scanner parsing adapters
- `remediation`: orchestration and remediation tools
- `api.ts` and `cli.ts`: public SDK and CLI entry points
- `mcp` and `openapi`: integration server surfaces

Use module boundaries as a design rule, not a guideline.

## Extension Scenarios

### Add a Scanner Adapter

What: support a new scanner output format.

Why: expand ingestion coverage for automation pipelines.

How:

1. add adapter in `packages/core/src/scanner/adapters`
2. normalize findings to existing scan contract
3. add tests for valid and malformed input
4. update [Scanner Inputs](scanner-inputs.md)

### Add a CVE Intelligence Source

What: add or adjust upstream vulnerability data source behavior.

Why: improve data completeness and fixed-version discovery.

How:

1. implement source module in `packages/core/src/intelligence/sources`
2. preserve merge semantics for existing sources
3. keep structured failure behavior
4. update contributor-facing docs where behavior changes

### Adjust Remediation Tooling

What: modify pipeline tool behavior or fallback strategy.

Why: improve success rate without weakening safety.

How:

1. preserve canonical tool order and contracts
2. retain dry-run and policy enforcement guarantees
3. update evidence reporting if decision flow changes
4. verify governance instructions remain aligned

## Governance Expectations

When changing runtime behavior, contributors must align with:

- agent safety guardrails
- orchestration tool order
- tool input/output contract requirements
- policy precedence and safety defaults

For major behavior changes, include documentation updates in the same pull request.

## Documentation Quality Standard

For each docs page, include:

- what the feature/capability is
- why it exists and when to use it
- how to use it in practical automation
- failure and troubleshooting behavior
- security implications and safe defaults
- related links to neighboring docs pages

This avoids fragmented docs and reduces operator misconfiguration risk.

## Contributor Workflow

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Use pnpm-first commands in docs unless compatibility context requires alternatives.

## Documentation Change Checklist

- update both conceptual and operational sections (what/why/how)
- add or update cross-links across affected docs pages
- keep terminology consistent: remediation/remediate as primary terms
- mark compatibility aliases as legacy when referenced
- verify examples use secure defaults (`--dry-run`, policy guidance, validation where relevant)
