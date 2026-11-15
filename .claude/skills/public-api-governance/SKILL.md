---
name: public-api-governance
argument-hint: Describe the public API change and which surfaces it touches.
description: Use when adding, renaming or reshaping anything callers see: SDK exports and types, option and report fields, CLI flags, MCP tool schemas, HTTP routes and their docs. Covers naming, schema shape, parity across surfaces and compatibility.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: contributor
user-invocable: true
---

# Public API governance

Contributor tooling for the public contract: SDK exports and types, CLI flags and output, MCP tool
schemas, OpenAPI routes, and the docs that describe them. It does not cover how remediation runs
internally; for that use the runtime skills. For adding an operation to the catalog, use
`mcp-tool-registration`.

## The wanted state

- **One concept, one name, everywhere.** The same term in the SDK, CLI, MCP, OpenAPI and docs. The
  canonical terms are in `AGENTS.md`; do not add synonyms or aliases.
- **One definition.** An operation, its option schema and its descriptions are declared once, in
  the catalog. MCP, HTTP and A2A are generated from it; the CLI reuses its schema and descriptions
  rather than retyping them.
- **A small, deliberate surface.** The root export list (`src/index.ts`) is curated. Internals, test
  seams and constants a caller never needs are not exported. Add an export only when a caller needs
  it and it is ready to be documented unchanged.
- **Results are unions, not bags.** A result with a `status` is a discriminated union; fields that
  only apply to some statuses exist only on those variants (see `boundaries-and-errors`).

## Naming

- camelCase for SDK fields and JSON properties; kebab-case for CLI flags that map to a field.
- Positive booleans (`runTests`, `evidence`), never inverted names.
- Group before you grow: related options go under a domain object (`changeRequest`, `constraints`,
  `provenance`), not as new root fields. Use the protocol's own term when one exists (`head`/`base`).
- One verb per concept across exported functions (`plan*`, `apply*`, `assess*`, `list*`, `get*`).
  The CLI command name may be friendlier, but its mapping to the function is documented.
- Think one version ahead: pick the name that survives the next likely extension.

## Parity in the same change

A new or changed field ships on every surface that exposes it, in one change: catalog schema (and
so MCP, HTTP, A2A), CLI flag and mapping, SDK type, policy-file key if it is configurable, GitHub
Action and GitHub App inputs if they forward it, tests, docs, and `llms.txt`. Partial rollout is a
defect. Where a surface does not expose it, record why in the change.

## Compatibility

- Breaking changes are allowed before 1.0 but must be intentional: a `minor` changeset with a
  migration section that lists every renamed or removed name.
- Keep `schemaVersion: "1.0"` unless a schema migration is approved.
- `ciExitCode` and report builders stay pure.
- Never expose internal module paths, model names or file paths in public descriptions.

## Checklist

- `pnpm typecheck:all && pnpm test:all && pnpm build:all` pass.
- Repo-wide search finds no stale name from a rename (code, docs, `llms.txt`, e2e).
- Catalog, CLI, SDK types, policy schema, docs and changeset agree; the CLI parity test covers the
  command.
- The changeset states the public impact first.
