---
name: code-structure
argument-hint: Describe the file or module change and what it belongs to.
description: Use when adding, moving, splitting or renaming source files, deciding where code belongs, or writing imports. Covers the feature-folder layout, dependency direction, module shape and size limits.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: contributor
user-invocable: true
---

# Code structure

The wanted state: a reader finds a feature by its name, everything the feature needs sits in one
folder, and dependencies point one way. This skill is the big picture; the mapping from today's
folders is in `docs/contributing/target-structure.md`.

## The layout

```
packages/core/src/
  index.ts          public SDK: one curated export list
  shared/           tiny kernel: errors, json/fs helpers, hashing, text, env. Imports nothing from the repo
  infra/            http, auth, locks, jobs, package managers, policy loading
  features/<name>/  one folder per capability
  surfaces/         cli, mcp, openapi, a2a, catalog
```

Dependencies point one way: `surfaces -> features -> infra -> shared`.

- A feature imports another feature only through that feature's `index.ts`.
- A feature never imports `surfaces/`. `shared/` and `infra/` never import `features/`.
- The rules are enforced by `boundaries.test.ts` and the `import/no-cycle` lint rule. Do not
  add an exception; change the design.

The layout is described in `docs/contributing/architecture.md`. New shared helpers go in
`shared/`; new capabilities go under `features/`; anything a surface needs from a feature goes
through that feature's `index.ts` (add one when a feature lacks it).

## A feature folder

```
features/diet/
  index.ts      the feature's public face: re-exports only, no logic
  analyze.ts    one verb per file once a file passes ~300 lines
  apply.ts
  types.ts      this feature's types and schemas: only what it owns
  diet.test.ts  tests sit next to the code they cover
```

- A feature starts as one file. It becomes a folder at two or more files.
- `index.ts` is an export list. Logic lives in named files.
- Types live with the feature that owns them. A type used by three or more features moves to
  `shared/`. There is no central types file.
- Tests are colocated as `<name>.test.ts`; test helpers go in `<feature>/testing/`, shared ones in
  `shared/testing/`. No other suffixes or helper folder names.

## Surfaces stay thin

A surface parses input, calls a feature and formats the result. One file per feature per surface
(`surfaces/cli/commands/diet.ts`, `surfaces/catalog/diet-operations.ts`). Option schemas and
descriptions are declared once, in the catalog, and reused; do not retype them for the CLI.
Output and exit codes go through one helper; do not call `process.stdout.write` or set
`process.exitCode` in feature code.

## Size and splitting

- Files stay under 400 lines; above 600, split before adding anything.
- Functions stay under 80 lines. A function with several phases becomes named steps.
- Split by responsibility (parse, decide, apply, format), not by arbitrary size.
- Repeated blocks become a helper; two copies is a prompt, three is a rule.

## Before you create a file

1. Is there a file in the owning feature that can hold this? Use it.
2. Is that file already mixed or large? Split it by concern, then add the behaviour.
3. Would a new file break the dependency direction? Then the design is wrong, not the rule.
4. Only then create one, and say in the PR what you checked and why it has one responsibility.

## Imports

- Relative imports end in `.js` (ESM, emitted by `tsc` as written).
- Type-only imports use `import type`. Built-ins use the `node:` prefix.
- Never import another feature's internals, and never import from `dist/`.

## External services

Before calling an HTTP API, look for an official or widely used SDK and use it. Raw `fetch` is
acceptable only for a narrow, read-only, stable endpoint with no SDK. Subprocesses go through
`safeExeca` (never raw `child_process`).

## Checklist

- The code is in the folder named for its feature, and the feature folder is not a grab-bag.
- No new `utils`, `helpers`, `common` or `misc` file: name files for what they do.
- Dependency direction holds; `pnpm lint` and the boundaries test pass.
- No file or function was pushed past the limits above; if one already was, it was split.
- `docs/contributing/target-structure.md` or the module map in `docs/contributing/architecture.md`
  updated if a folder was added or moved.
