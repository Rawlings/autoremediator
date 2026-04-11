# Autoremediator Agent Modes

## Modes

### Mode 1: Direct CVE

- Trigger: `autoremediator CVE-YYYY-NNNNN`, `remediate(cveId, options)`, or `planRemediation(cveId, options)`
- Behavior: single-CVE remediation pipeline
- Instruction set:
  - .github/instructions/orchestration.instructions.md
  - .github/instructions/agent-safety.instructions.md
  - .github/instructions/tool-contracts.instructions.md

### Mode 2: Scan Input

- Trigger: `autoremediator <scan-file>` or `remediateFromScan(inputPath, options)`
- Behavior: parse scanner findings, deduplicate CVEs, run Mode 1 for each CVE
- Instruction set: Mode 1 + scanner parser skill

### Mode 3: CI

- Trigger: `--ci`
- Behavior: non-interactive output, deterministic summary and exit code
- Instruction set: Mode 2 + evidence/ci skill

### Mode 4: MCP Tool Server

- Trigger: `autoremediator-mcp` (stdio)
- Behavior: exposes `remediate`, `planRemediation`, `remediateFromScan`, `listPatchArtifacts`, `inspectPatchArtifact`, and `validatePatchArtifact` as MCP tools
- Source: `packages/core/src/mcp/server.ts`

### Mode 5: OpenAPI HTTP Server

- Trigger: `node dist/openapi/server.js [--port 3000]`
- Behavior: POST `/remediate`, POST `/plan-remediation`, POST `/remediate-from-scan`, POST `/patches/list`, POST `/patches/inspect`, and POST `/patches/validate` over HTTP
- Source: `packages/core/src/openapi/server.ts`

### Mode 6: Governed Multi-Agent Delivery

- Trigger: feature work, refactors, or architecture-affecting contributor tasks
- Behavior: planner/developer/architect handoff model for autonomous delivery
- Instruction set:
  - .github/copilot-instructions.md (Agent Autopilot Contract + Multi-Agent Handoff Contract)
  - .github/instructions/architecture.instructions.md
  - .github/instructions/documentation-governance.instructions.md
  - .github/instructions/feature-completeness-gate.instructions.md
  - .github/instructions/testing.instructions.md
- Custom agents:
  - .github/agents/planner.agent.md
  - .github/agents/developer.agent.md
  - .github/agents/architect.agent.md

Mode 6 handoff stages and packet requirements are canonical in .github/copilot-instructions.md.

## Precedence

1. Explicit CLI/API options
2. Policy file (`.autoremediator.json`)
3. Tool contracts
4. Default behavior

## Public API Naming Canon

Across SDK, CLI mapping, MCP, and OpenAPI, use canonical public terms:

- `runTests`
- `policy`
- `evidence`
- `patchCount`
- `patchesDir`

Do not introduce synonym fields for these concepts.

Patch lifecycle operation naming canon:

- `listPatchArtifacts`
- `inspectPatchArtifact`
- `validatePatchArtifact`

## Fallback Policy

When a safe version exists but the vulnerable package is transitive:

1. apply-package-override using package-manager-native fields
2. only fall back to patch generation if override remediation cannot be applied

When no safe version exists:

1. fetch-package-source
2. generate-patch
3. apply-patch-file

If patch confidence is low or validation fails, result must be marked as unresolved and evidence must include reason.
