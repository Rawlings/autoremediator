---
name: boundaries-and-errors
argument-hint: Describe the data entering the system or the failure being handled.
description: Use when reading files, network responses, model output or caller input; when throwing, catching or returning a failure; or when tempted to cast with `as`. Covers parsing at boundaries, typed errors, expected failures, and file I/O.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: contributor
user-invocable: true
---

# Boundaries and errors

The wanted state: untrusted data is parsed once at the edge, everything inside is typed, and every
failure is either returned as a value, thrown as a typed error, or handled on purpose. This tool
edits people's dependencies, so a guess about data shape is a defect.

**Helpers named here** (`readJsonFile`, `errorMessage`, `AutoremediatorError`, the typed env reader)
are created in `shared/` at the start of the refactor. Until one exists, add it there once; do not
write a local copy.

## Parse at the boundary, trust inside

- **A boundary** is anywhere data enters from outside the process or the type system: a file read
  (run records, lockfiles, `package.json`, the policy file), a network response (registry, OSV,
  advisory feeds), scanner or model output, an HTTP body, CLI input, an environment variable.
- Such data is `unknown` until a schema (zod) has parsed it. Use the shared reader,
  `readJsonFile(path, schema)`, or `schema.parse` / `safeParse`. Never `JSON.parse(x) as T`.
- Define the schema next to the type it describes and derive the type from it
  (`type Run = z.infer<typeof runSchema>`), so the two cannot drift.
- Parse failures name the source and the field. A damaged persisted file is an error with a path,
  not a silently skipped entry or an invented default.
- Past the boundary, pass typed values and do not re-check. Do not defend against states the
  types already rule out.
- `as` is for narrowing you can justify in a comment. `as unknown as` is never acceptable; replace
  it with a parse, a type guard or a corrected type. Non-null `!` needs the same justification.

## Errors

- **Expected failures are values.** A package with no safe version, a patch the verifier rejects, a
  policy block: return a result whose type says so (a discriminated union on `status`) and let the
  caller branch exhaustively. Do not throw for them.
- **Unexpected failures throw a typed error.** Extend the shared base (`AutoremediatorError` with a
  stable `code`); callers match on the class or code, never on message text. `throw new Error(...)`
  is for code that cannot happen.
- **Never swallow silently.** A `catch` does one of: handle it (recover, retry, translate), rethrow
  with context (`cause`), or ignore it deliberately with a one-line reason. An empty block with no
  reason is a defect.
- Get the message with `errorMessage(error)`; preserve the original as `cause`.
- Invalid input fails loudly and early. No silent fallback to a default. A missing optional thing
  is `undefined`, not an empty string or `0`.
- Failures that reach a person say what failed, on what, and what to do; they never print secrets,
  tokens or file contents.

## Result shapes

- Model the states, not a bag of optionals. If `rolledBack` only exists when `status` is `failed`,
  the type is a union where only that variant has it.
- One convention for "ok or not": `status` as a string-literal union. Do not mix `ok: boolean`,
  thrown errors and an "unresolved" reason for the same kind of outcome in one feature.
- Handle every variant: switches on `status` are exhaustive (`switch-exhaustiveness-check`).

## File and process I/O

- In code reachable from a server, a job or an agent run, use `fs/promises`. Synchronous calls are
  for short-lived CLI start-up and tests.
- Do not `existsSync` then read. Read and handle `ENOENT`.
- Writes that must not tear (run records, the lockfile, policy) write to a temp file and rename.
- Subprocesses go through `safeExeca` with a timeout, an explicit `cwd` and no shell. File paths
  that came from a caller go through the path guard before use.

## Checklist

- Every `JSON.parse` result, `await response.json()`, `process.env` read and tool/model output goes
  through a schema or the typed reader.
- No new `as unknown as`; each new `as` and `!` has a reason a reviewer can read.
- No empty `catch`; every catch handles, rethrows with `cause`, or says why it is safe.
- Expected failures are in the return type; thrown errors are typed.
- No new sync fs in async or server-reachable code.
