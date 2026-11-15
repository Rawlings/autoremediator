---
description: Public API stability and cross-surface contract rules for SDK, CLI, MCP, and OpenAPI.
applyTo: packages/core/src/{api,cli,mcp,openapi,catalog,a2a,platform}/**/*.ts
---

# API Surface Instructions

Naming, parity and compatibility rules are in the `public-api-governance` skill; adding or changing
an operation is in the `mcp-tool-registration` skill. The SDK entry points and their options are in
`docs/reference/sdk.md`. This file keeps only the stability promises.

## Stability

- Report types carry `schemaVersion: "1.0"`. Do not change it without a migration and a changeset.
- The SDK root export list is the public API. Everything not exported from it is internal and must
  not be imported by consumers, including `remediation/tools/`, `intelligence/sources/` and
  anything under `platform/` or `infra/`.
- The CLI (`autoremediator` bin) is a stable interface: option names, exit codes and
  `--output-format json` shapes change only with a changeset. Patch lifecycle commands
  (`patches list`, `patches inspect`, `patches validate`) stay machine-readable.
- MCP, OpenAPI and A2A wrap the stable API through the catalog. They do not reach into internals.

## Parity

A public change ships on every surface that exposes it, in one change set: SDK, CLI, MCP, OpenAPI,
policy schema, GitHub Action and GitHub App forwarding where they expose it, docs, `llms.txt` and
`docs/reference/modes.md`. Do not assume an untouched surface is unaffected; verify and record why.
