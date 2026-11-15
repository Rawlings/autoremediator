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

**Contributor tooling.** MCP tools, HTTP routes and A2A skills are all generated from one list of operations in the catalog (`packages/core/src/surfaces/catalog/`). Read this when adding or changing an operation, its schema or its description. You do not edit `mcp/server.ts` to add a tool. It does not govern how the underlying remediation logic works; for that, use the runtime skills.

## When to Use

- Adding a new operation to the catalog (it becomes an MCP tool, an HTTP route and, if listed, an A2A skill).
- Renaming or deprecating an existing MCP tool.
- Changing a tool's input schema or result shape.
- Synchronizing MCP tool surface with the agent tool map.

## Inputs

- Existing operations in `packages/core/src/surfaces/catalog/` (one `<feature>-operations.ts` per feature, built with `define-operation.ts`) and the shared `responses.ts`.
- The MCP adapter in `packages/core/src/surfaces/catalog/adapters/mcp.ts` and the HTTP adapter beside it.
- Tool contracts in `.github/instructions/tool-contracts.instructions.md`.

## Outputs

- The operation defined once in the feature's `*-operations.ts` file; use the shared annotations and `RESPONSES`, not local copies.
- `A2A_SKILL_NAMES` in `packages/core/src/surfaces/a2a/agent-card.ts` only when the operation should be an A2A skill (it is a curated list).
- `docs/reference/modes.md` entries for Mode 4 (MCP) and Mode 5 (HTTP).
- Updated tool contracts when signatures change.
- Verified parity with SDK exports, CLI option exposure, OpenAPI schemas, and docs references for the same operation.

## Tool Naming Convention

MCP tools use stable API-facing names that map to exported SDK entry points:

| SDK/API function    | MCP tool name       |
| ------------------- | ------------------- |
| `remediate`         | `remediate`         |
| `planRemediation`   | `planRemediation`   |
| `remediateFromScan` | `remediateFromScan` |

## Guardrails

- Tool names are the catalog operation names and must match documented public behavior.
- MCP tool parameter fields must remain aligned with the underlying API option contracts.
- MCP tool descriptions must be precise enough for an LLM to select the correct tool without reading source code.
- Never expose internal implementation details (model names, file paths) in MCP tool descriptions.
- Ensure `preview`, `requestId`, `sessionId`, and `parentRunId` are exposed where applicable for orchestration contexts.
- For changed MCP input fields, verify whether GitHub action/workflow and GitHub App surfaces are affected by the same contract and update or record as not affected.

## Verification Checklist

- MCP tool list contains `remediate`, `planRemediation`, and `remediateFromScan`.
- Each tool's parameter schema is aligned with the underlying public API option contracts.
- The catalog tests pass and the MCP server starts without errors (`node dist/surfaces/mcp/server.js`).
- Running `autoremediator-mcp` registers the new tool; the generated OpenAPI document contains the route.
