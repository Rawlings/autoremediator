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

## Tool Naming Convention

MCP tools use verbatim kebab-case names matching the agent tool map:

| Agent tool name      | MCP tool name        |
|----------------------|----------------------|
| `lookup-cve`         | `lookup-cve`         |
| `check-inventory`    | `check-inventory`    |
| `check-version-match`| `check-version-match`|
| `find-fixed-version` | `find-fixed-version` |
| `apply-version-bump` | `apply-version-bump` |
| `fetch-package-source` | `fetch-package-source` |
| `generate-patch`     | `generate-patch`     |
| `apply-patch-file`   | `apply-patch-file`   |

## Guardrails

- MCP tool names must exactly match the entries in `tool-contracts.instructions.md`.
- Each MCP tool must expose the same Zod parameter schema used by the underlying agent tool.
- MCP tool descriptions must be precise enough for an LLM to select the correct tool without reading source code.
- Never expose internal implementation details (model names, file paths) in MCP tool descriptions.
- `apply-version-bump` and `apply-patch-file` must pass `dryRun` through from caller context.

## Verification Checklist

- MCP tool list matches `## Current Tool Inventory` in `tool-contracts.instructions.md`.
- Each tool's parameter schema is identical to the underlying agent tool definition.
- MCP server starts without errors (`node dist/mcp/server.js`).
- Running `autoremediator --mcp` registers all tools with the MCP host.
