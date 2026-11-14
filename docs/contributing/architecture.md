# Architecture

For contributors. Read [AGENTS.md](../../AGENTS.md) for the public naming canon and fallback rules,
and [CONTRIBUTING.md](../../CONTRIBUTING.md) for the workflow. The behavior these modules
implement is described in [How it works](../how-it-works.md).

## Layout (`packages/core/src`)

| Directory               | Responsibility                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `api/`                  | The public SDK and report helpers. Everything else is reachable only through it.        |
| `catalog/`              | Every capability defined once as an operation (zod input, annotations, handler). MCP tools are generated from it; HTTP routes and CLI commands are next. |
| `api/init/`             | `init`: a planner that turns detected facts into reviewable file changes (safe JSON/TOML/Markdown merges, never overwrites an existing entry), plus the text shared by the generated agent files and the Claude Code plugin under `plugins/`. CLI and SDK only. |
| `cli/`, `mcp/`, `openapi/` | Thin entry points: parse input, call `api/` or `catalog/`, format output. No remediation logic. |
| `remediation/local/`    | The pipeline (`run.ts`) and its stages: strategies, fallback, disposition, SBOM.        |
| `remediation/tools/`    | Single-purpose operations (version bump, override, patch apply, inventory, …).          |
| `remediation/patch/`    | Patch generation behind the `PatchGenerator` port; diff and syntax validation.          |
| `remediation/proof-of-fix/`, `remediation/refactor/` | Optional verification and codemods.                     |
| `remediation/repair/`   | Agent repair: the scoped tools and guard, the built-in agent loop, and the attempt (checkout, upgrade, verify, feedback rounds). |
| `remediation/verify/`   | The verifier: independent checks (scope, policy, supply chain, install, advisories, tests) that judge a changed project, whoever changed it. |
| `intelligence/sources/` | One module per advisory or signal source (OSV, GitHub, NVD, KEV, EPSS, npm registry).   |
| `scanner/`              | Scanner-output adapters and the git-aware delta scan.                                   |
| `runs/`                 | Run records on disk: hash-chained ledger, project fingerprints, persisted snapshots, plans, git worktrees. Imports `platform/` only. `api/runs` drives it. |
| `platform/`             | Shared kernel: types, policy, option schemas (`option-schemas.ts`, the one zod definition of every option), rollback, safe subprocess execution, evidence, jobs. |

`platform/` must not import from the other directories, `catalog/` may use only `api/` and `platform/`,
and the CLI, MCP and HTTP surfaces must go through `api/` rather than into `remediation/` or
`intelligence/`. `platform/boundaries.test.ts`
enforces both.

## The pipeline

`remediate()` → `runLocalRemediationPipeline`:

1. **Look up** the advisory (OSV + GitHub + NVD, then KEV and EPSS; or an offline snapshot).
2. **Preflight**: suppressions, exploit-signal gate, SLA check.
3. **Inventory and match**: installed packages whose version falls in a vulnerable range.
4. Per package, **primary strategy**: version bump, else override (supply-chain trust check,
   install, optional tests/type check/proof-of-fix, rollback on failure).
5. **Patch fallback** when the primary strategy cannot fix it and a generator is configured.
6. **Disposition, containment and escalation** classify each result.
7. **Report** with SBOM, evidence and aggregate counts.

There is no agent loop; the flow is deterministic. The only model call is
`PatchGenerator.propose` in step 5.

## Extension points

- **Patch source**: implement `PatchGenerator` (`platform/patch-generator.ts`) and pass it as
  `patchGenerator`, or use `createLlmPatchGenerator` with any AI SDK model.
- **Scanner format**: add an adapter under `scanner/adapters/` returning normalized findings and
  register it in `scanner/parse-input.ts`.
- **Intelligence source**: add a module under `intelligence/sources/` that returns or enriches
  `CveDetails`, and call it from the lookup stage.

## Conventions

- **Nothing fake.** An option, doc line or output field must be backed by behavior. If a feature is
  incomplete, remove it or label it experimental in its description.
- **Fail loudly.** Invalid input, policy and snapshots throw with a specific message. No swallowed
  errors, no silent fallback to defaults, no invented values.
- **Precedence is explicit options, then policy file, then defaults.** CLI boolean flags are
  `undefined` when not passed; never default them to `false`.
- **Subprocesses** go through `safeExeca` (sanitized environment, argument checks, timeouts).
- **Untrusted callers** (MCP, HTTP) cannot set credentials, hosts or paths outside the allowed roots.
- Public names follow the canon in `AGENTS.md`; SDK, CLI, MCP and HTTP must stay in sync.
