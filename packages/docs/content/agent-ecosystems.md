# Agent Ecosystems

This page focuses on MCP/OpenAPI integration patterns for agent runtimes and orchestration platforms.

It is intentionally standards-first: provider selection remains generic (`remote` or `local`), while integration hosts can vary by deployment.

Related references:

- [Integrations](integrations.md)
- [API and SDK](api-sdk.md)
- [CLI Reference](cli.md)
- [Policy and Safety](policy-and-safety.md)

## Why This Surface Exists

Agent workflows usually need:

- non-mutating planning before apply
- deterministic evidence and machine-readable summaries
- replay and correlation identifiers for orchestration traces
- post-remediation validation and patch artifact lifecycle operations

Autoremediator exposes all of these through SDK, CLI, MCP, and OpenAPI.

## Plan-First Workflow

Recommended sequence for agent orchestration:

1. call `planRemediation` for non-mutating intent
2. apply approval/policy checks in your orchestration layer
3. call `remediate` only when policy allows mutation
4. if patch fallback was used, call patch lifecycle operations:
   - `listPatchArtifacts`
   - `inspectPatchArtifact`
   - `validatePatchArtifact`

## MCP Setup

Start the MCP server:

```bash
autoremediator-mcp
```

Available MCP operations:

- `remediate`
- `planRemediation`
- `remediateFromScan`
- `listPatchArtifacts`
- `inspectPatchArtifact`
- `validatePatchArtifact`

Use MCP when your host already has tool-calling orchestration and you want a typed, stable remediation tool surface.

## OpenAPI Setup

Start the OpenAPI server:

```bash
node dist/openapi/server.js --port 3000
```

Primary routes:

- `POST /remediate`
- `POST /plan-remediation`
- `POST /remediate-from-scan`
- `POST /patches/list`
- `POST /patches/inspect`
- `POST /patches/validate`
- `GET /openapi.json`
- `GET /health`

Use OpenAPI when you need centralized remediation as a network service for many callers.

## Provider Guidance

Public provider model is generic:

- `llmProvider: "local"` for deterministic-first execution
- `llmProvider: "remote"` for remote model-backed execution

Remote adapter wiring is runtime-configured through environment and policy.

## Correlation and Replay for Agents

Use these fields in orchestration runs:

- `requestId`
- `sessionId`
- `parentRunId`
- `idempotencyKey`
- `resume`

They are propagated across reports and evidence artifacts for deterministic replay and traceability.

## Minimal SDK Example

```ts
import { planRemediation, remediate } from "autoremediator";

const plan = await planRemediation("CVE-2021-23337", {
  cwd: process.cwd(),
  llmProvider: "local",
  requestId: "req-001",
  sessionId: "nightly-security",
});

if (plan.results.every((r) => r.unresolvedReason !== "policy-blocked")) {
  await remediate("CVE-2021-23337", {
    cwd: process.cwd(),
    llmProvider: "remote",
    requestId: "req-001",
    sessionId: "nightly-security",
    parentRunId: plan.correlation?.requestId,
  });
}
```
