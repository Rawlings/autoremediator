---
name: code-style
argument-hint: Describe the code being written or reviewed.
description: Use when writing or reviewing any TypeScript in this repo. Covers how a file reads top to bottom, function style, naming, size, and the small idioms that must look the same everywhere.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: contributor
user-invocable: true
---

# Code style

The wanted state: any file looks like any other file. The formatter (oxfmt) decides whitespace and
the linter (oxlint) catches what it can; this skill covers what neither does. When in doubt, copy
the closest well-formed neighbour, and fix the neighbour if it is not.

## How a file reads

Top to bottom, in this order:

1. A doc comment saying what the file is for and why (every non-trivial file).
2. Imports (formatter sorts them).
3. Exported types, then constants.
4. Exported functions, public entry first.
5. Private helpers, below the code that calls them, in call order.

A reader should get the story from the exports without reading the helpers.

## Functions

- Module-level functions are `function` declarations. Arrow functions are for callbacks and inline
  values, not named module-level code.
- One parameter object once there are three or more parameters or any boolean flag. No positional
  booleans: `f(cmd, false, false)` says nothing.
- A function does one thing at one level. If you need a comment to label a phase, the phase is a
  function.
- Keep nesting shallow: return early, extract the inner block. No nested ternaries; use `if`.
- Braces on every `if`/`else`/loop whose body spans lines. A one-line `if (x) return;` may stay
  unbraced.

## One way to do each thing

Use the shared helper. If it does not exist, add it to `shared/` once, instead of writing the
idiom again.

| Need | Do |
|---|---|
| Message from a caught value | `errorMessage(error)`, not `error instanceof Error ? ...` |
| "Is this a plain object" | `isRecord(value)` |
| Read and write JSON | `readJsonFile(path, schema)` / `writeJsonFile` |
| Hash, sleep, posix path, plural | the `shared/` helper, never a local copy |
| Optional property in an object literal | one agreed form (see below) |
| Print a result and set the exit code | `emitReport(...)` in the CLI surface |
| Read an env variable | the typed env reader, not `process.env` in feature code |

**Helpers named here** (`errorMessage`, `isRecord`, `readJsonFile`, `defined`, `emitReport`, ...)
are the first things the refactor adds to `shared/` and the CLI surface. Until one exists, create
it there once and use it; do not write a local copy.

**Optional properties.** Build the object with a helper that drops `undefined` (`defined({ a, b })`)
instead of `...(x ? { x } : {})`. Write one form; never mix forms in a file.

## Naming

One verb per concept, everywhere:

| Kind | Verb |
|---|---|
| turn data into text for people | `format*` (not `describe`, `render`, `print`, `summarize`) |
| convert one shape to another | `to*` |
| construct a thing | `create*` |
| read from disk or network | `read*` / `fetch*` |
| judge or check, returns a verdict | `assess*` or `check*` (pick by what the feature already uses) |
| plan without effects / apply a plan | `plan*` / `apply*` |

- Booleans read as questions: `isX`, `hasX`, `shouldX`, `canX`. Positive names (`runTests`, not
  `skipTests`).
- Names say what, not how. No `util`, `helper`, `data`, `info`, `handle`, `process` on their own.
- Files are kebab-case and named for what they hold. Status and kind values are string-literal
  unions, never enums.
- Canonical public terms (`runTests`, `policy`, `evidence`, `patchesDir`, ...) are in `AGENTS.md`.

## Text, comments and constants

- Lines up to 100 characters. A string that cannot be wrapped is built from named parts, not one
  long template literal.
- Name magic numbers and regexes that carry meaning (`MAX_SUMMARY_CHARS`, `VERSION_RANGE`).
- Doc comments (`/** */`) explain why, constraints and surprises; they do not repeat the name.
  No commented-out code. `TODO` needs an owner or an issue.

## Checklist

- File order as above; nothing exported below a pile of helpers.
- No function over 80 lines, no nested ternary, no positional boolean.
- No locally redefined `isRecord`, `sleep`, `sha256`, error-message idiom.
- Verb and shape match the table; names match their neighbours.
- `pnpm lint && pnpm format:check` clean and `node scripts/quality-metrics.ts` no worse.
