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
- Behavior: exposes `remediate`, `planRemediation`, and `remediateFromScan` as MCP tools
- Source: `packages/core/src/mcp/server.ts`

### Mode 5: OpenAPI HTTP Server

- Trigger: `node dist/openapi/server.js [--port 3000]`
- Behavior: POST `/remediate`, POST `/plan-remediation`, and POST `/remediate-from-scan` over HTTP
- Source: `packages/core/src/openapi/server.ts`

## Precedence

1. Explicit CLI/API options
2. Policy file (`.autoremediator.json`)
3. Tool contracts
4. Default behavior

## Fallback Policy

When no safe version exists:

1. fetch-package-source
2. generate-patch
3. apply-patch-file

If patch confidence is low or validation fails, result must be marked as unresolved and evidence must include reason.
