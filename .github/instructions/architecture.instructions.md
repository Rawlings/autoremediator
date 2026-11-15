---
description: Where code goes and which way dependencies point in packages/core.
applyTo: packages/core/src/**/*.ts
---

# Architecture Instructions

The rules live in one place each; this file only points to them so they cannot drift.

- **Layout, dependency direction, module shape, size limits, imports, external services:** the
  `code-structure` skill. The module map and boundary rules are in
  `docs/contributing/architecture.md`, and `packages/core/src/platform/boundaries.test.ts` enforces
  them. The target layout and the migration mapping are in `docs/contributing/target-structure.md`.
- **How a file and a function should read, naming, shared idioms:** the `code-style` skill.
- **Untrusted data, errors, expected failures, file and process I/O:** the `boundaries-and-errors`
  skill.

## Non-negotiables

- Dependencies point one way: surfaces, then features, then infra, then shared. A new edge that
  breaks this is a design defect, not an exception to add.
- Reuse, then refactor, then create. A new file or folder needs a stated reason.
- Files stay under 400 lines and functions under 80; split by responsibility before adding to a
  file that is already over.
- Parse data at the boundary; do not cast it.

## Enforcement

`pnpm lint`, `pnpm format:check`, `pnpm typecheck:all`, `pnpm test:all` and
`node scripts/quality-metrics.ts` (the numbers only go down). Use the `governance-check` skill to
verify these governance files are present and aligned with the code.
