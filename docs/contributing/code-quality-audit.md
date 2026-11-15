# Code quality audit

**Status: draft for review (Phase 1 of the code quality turnaround).** This is the baseline the
refactor is measured against. Numbers come from `node scripts/quality-metrics.ts` (a real parse,
tests and fixtures excluded) unless a section says otherwise. The proposed layout is in
[target-structure.md](target-structure.md).

## Summary

The compiler and lint settings are strong and nothing here is a correctness crisis. The code is hard
to read for three reasons that compound: there is no fixed *shape* (folders, files and functions
each follow several conventions), the same idioms are copied instead of shared, and the guidance
that exists describes a layout the code no longer has and is not enforced by any tool.

| Area | Verdict |
|---|---|
| Compiler strictness, lint type-awareness, import hygiene | Good, keep |
| Folder structure and module shape | Inconsistent: features split across 2-3 folders |
| Function and file size | Poor: 129 functions over 80 lines, 41 files over 400 |
| Duplicated idioms and helpers | Poor: error idiom 106x, 81 helper names defined in more than one file |
| Boundary validation | Weak: 60 `JSON.parse(...) as T`, `no-unsafe-type-assertion` switched off |
| Naming | Inconsistent: five verbs for "render text", four for "construct" |
| Agent and contributor guidance | Stale and unenforced |

## Baseline numbers

Production code only. `core` is `packages/core/src`.

| Metric | core | github-app | vscode-ext |
|---|---:|---:|---:|
| Files / lines | 348 / 69,178 | 29 / 5,757 | 3 / 613 |
| Files over 400 / 600 / 800 lines | 41 / 15 / 6 | 3 / 2 / 2 | 0 |
| Functions over 80 / 100 lines | 129 / 89 | 12 / 10 | 2 / 1 |
| `as` casts (excluding `as const`) | 546 | 47 | 8 |
| `as unknown as` | 20 | 0 | 0 |
| `JSON.parse(...) as T` | 60 | 4 | 3 |
| Non-null `!` | 220 | 14 | 0 |
| `any` | 12 | 0 | 0 |
| Error-message idiom (`e instanceof Error ? e.message : ...`) | 106 | 34 | 1 |
| Conditional spreads `...(x ? {x} : {})` | 453 | 5 | 0 |
| Nested ternaries | 142 | 9 | 3 |
| Brace-less `if`, multi-line / one-line | 169 / 1,627 | 4 / 53 | 1 / 16 |
| Silent catch (empty or comment-only) | 77 | 0 | 0 |
| Sync fs / exec calls | 418 | 7 | 6 |
| `process.env` reads | 16 | 2 | 0 |
| Lines over 100 characters | 1,458 | 69 | 4 |
| Module-level `function` / arrow functions | 1,434 / 192 | 122 / 1 | 14 / 0 |
| `types.ts` files | 20 | 1 | 0 |
| `index.ts` files that contain logic | 28 | 1 | 0 |
| Helper names defined in more than one file | 81 | - | - |

## Findings, ranked by how much they hurt readability

### 1. Very long functions made of copy-pasted blocks

- `remediation/tools/apply-package-override/index.ts`: one `execute` arrow is about 550 lines. The
  Deno branch and the npm/pnpm branch are near-duplicates (proof-of-fix negative phase, install,
  retry, positive phase, cleanup). The same 8-field `PatchResult` literal appears about 15 times
  and `safeExecaCommand(cmd, { timeoutMs, cwd, stdio: "pipe" })` 9 times.
- Longest: `createProgram` 675 lines, `bisectLockfile` 472, `transformFileContent` 356,
  `runLocalRemediationPipeline` 351, `applyPlan` 270.
- Inside `applyPlan` the same `others = plan.items.filter(...).map(...)` block appears twice.

### 2. Output and exit-code handling is copied, in two styles

- `cli/runners.ts` (1,407 lines) holds about 30 unrelated command runners and 143
  `process.stdout.write` calls. `describe*` helpers beside them build an array and write once. Both
  styles coexist.
- `runSingleCve` and `runScanInput` repeat the same sarif / cyclonedx-vex / json branches, each
  ending in `if (opts.ci) process.exitCode = ciExitCode(...)`: 12 copies. There are 49 hand-written
  `outputFormat === "json"` branches.
- Servers print with `console.log` / `console.error`; the CLI with `process.stdout.write`.

### 3. No fixed file or folder shape

- **Folders:** one feature lives in several places: `api/runs` + `runs/`, `api/memory` +
  `platform/memory`, `api/maintainer-vex` + `platform/maintainer-vex`, `api/radar` +
  `remediation/radar`, `api/recipes` + `recipes/`, `api/trace` + `trace/`, `api/autonomy` +
  `autonomy/`, `api/patches` + `remediation/patch`.
- **Module shape:** some features are a folder with only an `index.ts` (`api/assess`, `api/vex`),
  others a single file of similar size (`platform/rollback.ts`). 28 `index.ts` files hold real
  logic (10.5k lines in total); others are pure barrels (`api/index.ts` is 462 lines of re-exports).
- **`platform/` is a grab-bag:** it holds domain code (`repair-agent.ts`, `patch-generator.ts`,
  `rollback.ts`, `escalation.ts`, `evidence.ts`, `policy-loosening.ts`).
- **`platform/types.ts`:** 928 lines, 87 exported types from unrelated areas, imported by 164
  files, beside 19 per-feature `types.ts` files.
- **Inside a file:** only 22 files use section banners. Helpers sit above callers in some files and
  below in others; interfaces appear wherever first used (`runners.ts`) or at the top (`runs`).
- **Tests:** 212 colocated `*.test.ts`, 13 suffix variants (`.challenge`, `.e2e`, `.memory`, ...),
  and helper folders under two names (`__tests__/` and `tests/`).

### 4. Mixed function and parameter style

- 1,434 module-level `function` declarations and 192 arrow functions, often in the same file
  (`program.ts`, `bisect/index.ts`).
- Options parameters are typed four ways inside `runners.ts` alone: the full `CommandOptions`, a
  `Pick<...>`, an inline object type, and a named interface. Positional booleans such as
  `addSharedOptions(cmd, false, false)` hide meaning.

### 5. Same concept, different names

- Turning data into text: `describe*` (39), `render*` (13), `format*` (4), `print*` (3),
  `summarize*` (3). `describeSite` is defined twice with different signatures.
- Constructing: `build*` (35), `create*` (43), `to*` (24), `make*` (4), `as*` (3).
- Getter-like suffixes: `outcomeOf`, `outcomesFrom`, `planOptionsFrom`, `minAgeHoursFor`.
- `process.env.X` (15) vs `process.env["X"]` (3). `JSON.stringify(v, null, 2) + "\n"` (15) vs a
  template literal (18).

### 6. Duplicated helpers and idioms

- The error-message idiom is inlined 106 times in core and 34 in github-app; there is no helper.
- Guards for "is this a plain object": `isRecord` (3 files), `isObject`, `isPlainObject`,
  `asRecord`, plus about 30 inline checks.
- `sleep` is defined three times, `toPosix` twice, `sha256` once in `runs/hash.ts` and again in
  `api/prove/harness.ts`, with `createHash("sha256")` written directly in 16 files.
- JSON reading: three helpers (`readJson`, `readJsonObject`, `readJsonBody`) and 42 inline
  `JSON.parse(readFile...)` calls.
- 453 conditional spreads written in three different ways (`x ? {x} : {}`, `x === undefined ? {} :
  {x}`, and mutating an empty typed object). `api/runs/index.ts` alone has 35.

### 7. Long lines and nested ternaries inside templates

- 1,458 lines in core exceed 100 characters, mostly string literals the formatter cannot wrap. The
  longest is 1,119 characters (`catalog/radar-operations.ts`).
- 142 nested ternaries; some sit inside `${}` in template literals. Pluralisation is written inline
  19 times with no `plural()` helper. 289 inline regex literals and many magic numbers
  (`.slice(0, 120)`, `padEnd(11)`).

### 8. Unvalidated data at trust boundaries

- 60 `JSON.parse(...) as T` in core (`RunStore.load` casts a file read from disk to `RunRecord`).
  zod is a dependency with 43 `z.object` definitions but only about 15 direct `parse` or
  `safeParse` calls outside the option-schema layer.
- `typescript/no-unsafe-type-assertion` is turned off in `.oxlintrc.json` with a comment saying to
  revisit "once those boundaries are validated". It has not been revisited.
- 20 `as unknown as` double casts, mostly in `cli/program.ts` (the `CommandOptions` merge) and
  `mcp/resources.ts`.

### 9. Error handling

- 321 `throw new Error(...)`, no shared error base, about 10 ad hoc `extends Error` classes.
- 77 catch blocks that do nothing visible. The ones sampled carry an explanatory comment, but they
  are still silent and nothing marks them as intentional to a reader skimming the code.
- Expected failures are modelled three ways: thrown errors, `{ ok: true | false }` unions
  (13 files) and "unresolved" outcomes.

### 10. Synchronous I/O in an async architecture

- 418 sync fs/exec calls across 104 files against 12 files that import `fs/promises`, inside code
  with about 400 `async` functions. `existsSync` followed by a read is a check-then-use race;
  catching `ENOENT` is the safer form. `RunStore` is synchronous and hard-wired to `node:fs`.

### 11. Weak state modelling

- Two real discriminated unions, 243 `Record<string, unknown>`, and large optional-field option
  bags. `exactOptionalPropertyTypes` is deliberately off, which is why the conditional-spread
  pattern is everywhere.

## Layering and dependencies (measured)

Imports between top-level folders in `packages/core/src` (rows import columns; only non-zero
edges shown):

- `api -> platform` 150, `api -> remediation` 72, `api -> runs` 32, `api -> scanner` 17,
  `api -> intelligence` 13, `api -> recipes` 10, `api -> autonomy` 7, `api -> trace` 5.
- `remediation -> platform` 108, `remediation -> intelligence` 14, `remediation -> runs` 2,
  `remediation -> recipes` 2, `remediation -> scanner` 1.
- `scanner -> platform` 7, `scanner -> remediation` 1.
- `cli -> api` 19, `cli -> platform` 9; `catalog -> api` 7, `catalog -> platform` 11;
  `mcp`, `openapi`, `a2a` all import `catalog` and `platform`.
- `platform` and `recipes` import nothing from other folders.

Conclusions: the layering is clean in the direction that matters (nothing below `api/` imports
`api/`, `cli/`, `mcp/` or `openapi/`). The only top-level cycle is `remediation <-> scanner`, one
import each way. Inside `api/` there are mutual edges between the loose `api/*.ts` files and the
features `vex`, `portfolio`, `remediate`, `runs`, `remediate-from-scan`, `update-outdated` and
`jobs`, which is what happens when shared code has no home of its own. `remediation/tools <->
remediation/verify` is the one cycle inside `remediation`.

## Existing guidance

- **No code-level guidance in the agent files.** `AGENTS.md` (233 lines) is about 70% product
  catalogue; `.github/copilot-instructions.md` and the instruction files cover process and
  structure; there is no `CLAUDE.md` and `.claude/` is empty, so none of the 15 contributor skills
  in `.github/skills` reach Claude Code.
- **Stale and contradicted by the code:**
  - The `architecture` instruction and the `architecture-conventions` skill list `detection/` and
    `exposure/` as reserved (neither exists) and omit `catalog/`, `a2a/`, `autonomy/`, `recipes/`,
    `runs/` and `trace/`.
  - "`mcp/` and `openapi/` import from `api/index.ts` only" is false: they import `catalog/`,
    `platform/`, `runs/` and `spec/`.
  - "Cross-module imports use the module's barrel" is broken 109 times (deep imports from `api/`
    into `remediation`, `intelligence`, `scanner`).
  - The `mcp-tool-registration` skill says to add tools in `mcp/server.ts`; tools are now
    generated from `catalog/`.
  - Size limits (~400 lines per file, ~80-100 per function) are written down but 41 files and 129
    functions exceed them. No lint rule enforces them.
- **Duplication between guidance files:** "reuse, then refactor, then create", the dependency
  rules, the touchpoint matrix and the changeset/docs rules each appear in three to five files. Two
  module maps disagree (`docs/contributing/architecture.md` is current; the instruction and skill
  are not).
- **Good code-level rules exist but are hidden:** "fail loudly on invalid input", "surfaces are
  thin", "no swallowed errors", "all subprocesses go through `safeExeca`" live only in
  `CONTRIBUTING.md` and `docs/contributing/architecture.md`; no agent file links to them.
- **Tooling:** oxfmt (100 columns, sorted imports) and oxlint (type-aware, warnings fail) run in
  CI. oxlint has no `curly`, `no-nested-ternary`, `func-style`, `max-lines` or
  `max-lines-per-function` rule. `oxfmt --check` fails today only on files with uncommitted edits.

## What is already good (keep)

- `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals`,
  `verbatimModuleSyntax` and `erasableSyntaxOnly` are on; one `@ts-*` comment and no
  `eslint-disable` in the whole repo; no enums.
- Imports are grouped and ordered consistently (node, external, relative) and every built-in uses
  the `node:` prefix; names are kebab-case throughout.
- Doc comments explain why and are well written; there are no TODOs or commented-out code.
- The catalog already generates MCP tools and HTTP routes from one definition, and 13
  `*-operations.ts` files show the per-feature pattern the rest of the code should follow.
- `platform/boundaries.test.ts` already enforces dependency rules by test.

## Tests

213 test files, 49k lines (core non-test source is 69k). 61 of the 128 test files that have a
same-name source file are longer than that source.

- **Suffix variants are arbitrary.** `.test.ts` 180, `.challenge.test.ts` 15, `.e2e.test.ts` 5,
  `.memory` 4, and nine one-off suffixes (`.secops`, `.scope`, `.git-ref`, `.auth-required`, ...).
  Nothing treats them differently: there is no vitest config in `packages/core`, the script is plain
  `vitest run`, and CI runs one `pnpm test:all`. `freshness.e2e` sets its own hook timeout in the
  file. 27 files use real git, and not only the e2e ones. "Challenge" suites carry project-history
  titles ("Milestone 4 Challenge", "Tier 5 White-Box Adversarial").
- **Support folders are named three ways:** `__tests__/` (5), `tests/` (3), `fixtures/` (2), with
  different file names inside (`fixtures`, `registry`, `fake-registry`, `project`, `repo`, `world`).
  The names matter: `tsconfig.build.json` excludes only `__tests__` and `tests` from `dist`. One
  `__tests__` folder also holds a test file. Support code is imported across features
  (`api/radar` imports `remediation/impact/__tests__/fixtures.js`).
- **No shared test-utils location**, so helpers are re-invented:
  - inline `mkdtempSync(join(tmpdir(), ...))`: 104 files; 3 never remove the directory
  - a local `git(...)` helper: 23 definitions with 5 different signatures; git repo setup
    (`init` + `user.email`) in 25-27 files
  - `package.json` written inline in 37 places; a hand-built `CveDetails` in 34 files
    (`CVE-2021-23337` appears 188 times)
  - two near-duplicate fake npm registries (`bisect/tests/fake-registry.ts`,
    `freshness/tests/registry.ts`)
  - the same `vi.mock` target repeated across files (`check-inventory.js` 12x, `execa` 8x,
    `command-check.js` 8x) and 15 files stubbing `fetch` in four different ways
- **Style is otherwise consistent:** `describe` + `it` everywhere (no `test(`), behaviour-verb case
  names, cleanup via `afterEach` + `rmSync` in 96 of 104 files.
- Tests reach into internals by deep relative path (84 files at depth 1, 93 at depth 2) and only 5
  import through a barrel.

## Sibling packages

- **`packages/github-app/src`** (29 files, 5.7k lines): flat top level with `healing/`, `doctor/`
  and `diagnostics/` folders. Imports core in only three places, all from the package root
  `autoremediator`. `remediation-handler.ts` (961 lines) holds a 395-line closure
  (`createDefaultRemediationHandler`) plus audit-output parsing and subprocess code that core also
  has; `server.ts` (901 lines) has a 365-line `handleRequest` and a 320-line
  `createGitHubAppServer`. Same style findings as core: 34 copies of the error idiom (and
  `String(error)` used in other places), 53 one-line and 4 multi-line brace-less `if`s,
  `(installation as { id?: unknown }).id` written in two files.
- **`packages/vscode-extension/src`** (3 files, 613 lines): small. `activate` is one 137-line
  function; `runner.ts` wraps the CLI binary and casts parsed JSON (`as ScanReport`). Uses a
  different error idiom (`(err as Error).message`).
- **Not covered by lint or format:** `e2e/` (16 test files, 2.9k lines, not in the workspace and not
  run by CI) is ignored by oxlint; `dagger/` is ignored by oxlint. `bench/` (24 files) is linted and
  is the only package with a vitest config. `plugins/claude-code/` is generated, not a convention
  target.

## Surfaces

MCP tools, OpenAPI routes and A2A skills are generated from the catalog, so adding an option costs
nothing there. The CLI is the only hand-written surface, and it repeats what the catalog already
says.

- **Files touched to add one option:** guard 4 source files (`api/guard`, `catalog/operations.ts`,
  `cli/program.ts`, `cli/runners.ts`) plus 3-4 docs; remediate 6-7 source files; freshness 3, with
  the option declared three times inside one file (interface, `.option(...)`, mapping).
- **The same text and option is declared in several places** and has started to drift:
  `minPublishAgeHours` has two different description strings (catalog vs CLI flag
  `--min-age-hours`); freshness repeats the descriptions and re-implements the change-request
  checks that `cli/validators.ts` already has; `diet` has `--package-manager` and `--verbose` on
  the CLI but the catalog's `removeUnusedDependencies` has neither (and has `typecheck`, which the CLI
  lacks). `guardGitDiff` and `applyFreshness` have no catalog operation at all.
- `OPTION_DESCRIPTIONS` is used by about 116 of about 296 CLI `.option(` calls.
  `cli/option-parity.test.ts` checks only the `cve` command against the wire schema.
- **Output:** 173 `process.stdout.write` calls (143 in `runners.ts`), about 55 `logJson` calls,
  `"json"` branched on in 16 files, `validateOutputFormat` called 51 times. Formatter helpers
  (about 20) live in five places: `runners.ts`, per-feature CLI files, `cli/result-lines.ts`,
  `cli/output.ts` and `api/` (`renderIncidentMarkdown`, `renderRadar`).
- **Exit codes: six patterns, 35 assignments in 10 files:** `ciExitCode(toCiSummary(...))` gated on
  `--ci` (8 copies in `runners.ts`), per-feature helpers (`guardExitCode`, `incidentExitCode`,
  `radarExitCode`, `portfolioExitCode`), `EXIT_CODES.*` constants, bare `0`/`1` literals, a
  hard-coded `130` in `bisect.ts`, and `trace.ts` passing the child's code through.
- **CLI file layout:** eight features have their own `*-commands.ts` file with a
  `register*Commands` function; five more (`autonomy`, `bisect`, `trace`, `triage`, `recipes`) have a
  file but a different registration style; about 13 features are lumped into `runners.ts`, with
  their commands declared in `program.ts` (about 18 top-level commands inline).
- **`catalog/operations.ts` (928 lines):** 40 operations inline and 16 more in 8 `*-operations.ts`
  files. The only rule is "newer features got a file"; diet, guard, autonomy, recipes, bisect and
  assess are newer and are still inline. Five files redefine a local `response()` helper instead of
  using `RESPONSES`; annotations come in three styles (shared constants, per-file constants,
  13 inline literals).

## Public API

- `api/index.ts` exports 124 values and 287 types (411 names, 462 lines). Surfaces use 89 of the
  values and bypass the barrel 14 times (for example `HOOK_HOSTS` from `api/guard/hook.js`).
- **24 exported values are used by nothing outside `api/` except tests**, for example the
  `create*SchemaProperties` helpers, `IMPACT_POINTS`, `MEDIUM_THRESHOLD`, `hookOutputFor`,
  `runClaudeCodeHook`, `scanSecrets`, `discoverRepos`, `defaultProveDeps`, `MEMORY_PATH` and the
  evidence-pack predicate constants; 11 more appear only in docs and tests. These are candidates
  to make internal.
- **Verbs:** about 106 function names with about 60 distinct first words. The read-only
  "judge or report" family uses seven (`guardPackage`, `evaluatePackage`, `checkReachability`,
  `assessUpgrade`, `analyzeDependencies`, `scanDelta`, `findVulnerableSymbols`); several are bare
  nouns (`incident`, `radar`, `maintain`, `premortem`, `init`). CLI command verbs differ from API
  verbs (`diff` -> `scanDelta`, `diet` -> `analyzeDependencies`). There are two different
  `AttemptStatus` types.
- **Result types that should be discriminated unions** (a `status` string beside optional fields
  that only apply to some values): `PatchResult` (about 31 fields, 25 optional),
  `PolicyCompileResult`, `DietApplyResult`, `ApplyFreshnessResult` / `FreshnessStepOutcome`,
  `ProveResult`, `AttemptView` (5 optionals depend on the calling function), `PatchReconcileResult`,
  `BisectReport`, and the `ScanReport` / `PortfolioReport` / `UpdateOutdatedReport` family, which
  repeats `"ok" | "partial" | "failed"` in 9 places and stores counts that can be derived.
- **Blast radius of breaking changes is small for runtime code:** only five values are imported
  from `autoremediator` anywhere in the workspace (`remediateFromScan` by github-app;
  `applyPlan`, `getRun`, `readAttemptArtifact`, `planRemediation` by bench), plus a few types. The
  vscode extension and github-app also spawn the CLI, so CLI flags and JSON shapes are part of
  their contract.
- **The real fragility is internal imports from outside core:** 14 `e2e/` files and
  `scripts/quality-metrics.ts` import about 17 internal modules by path
  (`platform/{policy,rollback,jobs,types}`, `remediation/tools/**`, `remediation/local/disposition`,
  `api/change-request`, `openapi/{spec,handlers}`, and one deep `dist/remediation/repair/...`
  import). Any folder move breaks them, and CI does not run `e2e/`. Third-party npm consumers are
  unknown; the documented names are in `docs/reference/sdk.md` and `llms.txt`.

## What this audit does not cover

- Behaviour, performance and security of the product itself.
- Per-file readability beyond the sampled files named above; the metrics script is the way to
  measure the rest.
- The `plugins/claude-code/` generated files and the product docs under `docs/guides`.
