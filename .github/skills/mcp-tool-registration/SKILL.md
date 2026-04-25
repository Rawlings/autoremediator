---
name: mcp-tool-registration
argument-hint: Describe the MCP tool schema or registration change required.
description: Use when adding, renaming, or modifying tools exposed through the MCP server, or changing MCP tool schemas, descriptions, or result shapes.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: contributor
user-invocable: true
---

# MCP Tool Registration

## Scope

**Contributor tooling.** This skill governs the MCP tool surface — what tools are registered, their schemas, and how they map to the SDK API. Read it when extending or modifying `packages/core/src/mcp/server.ts`. It does not govern how the underlying remediation logic works; for that, use the runtime skills.

## When to Use

- Adding a new tool to `packages/core/src/mcp/server.ts`.
- Renaming or deprecating an existing MCP tool.
- Changing a tool's input schema or result shape.
- Synchronizing MCP tool surface with the agent tool map.

## Inputs

- Existing tool definitions in `packages/core/src/remediation/tools/`.
- MCP server registration in `packages/core/src/mcp/server.ts`.
- Tool contracts in `.github/instructions/tool-contracts.instructions.md`.

## Outputs

- Updated `packages/core/src/mcp/server.ts` tool registrations.
- Updated tool contracts when signatures change.
- Verified parity with SDK exports, CLI option exposure, OpenAPI schemas, and docs references for the same operation.

## Tool Naming Convention

MCP tools use stable API-facing names that map to exported SDK entry points:

| SDK/API function       | MCP tool name       |
|------------------------|---------------------|
| `remediate`            | `remediate`         |
| `planRemediation`      | `planRemediation`   |
| `remediateFromScan`    | `remediateFromScan` |

## Guardrails

- MCP tool names must exactly match registered names in `packages/core/src/mcp/server.ts` and documented public behavior.
- MCP tool parameter fields must remain aligned with the underlying API option contracts.
- MCP tool descriptions must be precise enough for an LLM to select the correct tool without reading source code.
- Never expose internal implementation details (model names, file paths) in MCP tool descriptions.
- Ensure `preview`, `requestId`, `sessionId`, and `parentRunId` are exposed where applicable for orchestration contexts.
- For changed MCP input fields, verify whether GitHub action/workflow and GitHub App surfaces are affected by the same contract and update or record as not affected.

## Verification Checklist

- MCP tool list contains `remediate`, `planRemediation`, and `remediateFromScan`.
- Each tool's parameter schema is aligned with the underlying public API option contracts.
- MCP server starts without errors (`node dist/mcp/server.js`).
- Running `autoremediator-mcp` registers all tools with the MCP host.
