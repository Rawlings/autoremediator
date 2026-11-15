# Architecture

For contributors. Read [AGENTS.md](../../AGENTS.md) for the wanted state and the public naming canon,
[Modes and runtime behaviour](../reference/modes.md) for fallback rules and precedence, and
[CONTRIBUTING.md](../../CONTRIBUTING.md) for the workflow.

Update this page in each change that adds or moves a folder. How the layout was reached is in
[Target structure](target-structure.md). The behavior these modules
implement is described in [How it works](../how-it-works.md).

## Layout (`packages/core/src`)

Four layers and one public barrel. Dependencies point one way: `surfaces -> features -> infra ->
shared`. `api/` (today just `index.ts`, the SDK export list) sits beside `surfaces/`.

| Directory | Responsibility |
| --- | --- |
| `shared/` | The kernel, importing nothing else in the package: typed errors and `errorMessage`, `isRecord`, JSON read and parse with a schema (`json.ts`), `sha256`, `sleep`, `toPosix`, `pluralize`, path guard, redaction, safe subprocess execution (`exec/`), the few types three or more features share (`types.ts`), the committed state-file paths (`state-paths.ts`), the package version. `governance/` holds the repository's own rule tests (boundaries, lint baseline, skill mirror). |
| `infra/` | Machinery every feature uses: the policy file and its schemas (`policy/`), HTTP auth, client and security (`http/`), job registry (`jobs/`), package-manager detection and commands plus cooldown and workspace discovery (`package-manager/`), the rollback transaction (`rollback/`), the repo lock, environment config. |
| `features/<name>/` | One folder per capability. `remediate/` is the pipeline (`local/`, `scan/`, `portfolio/`) and the report types; `runs/` is run records and the plan/apply/verify flow; `patch/`, `upgrade/`, `verify/`, `repair/`, `refactor/`, `impact/`, `reachability/` are what the pipeline calls; `intelligence/` (sources, evaluate), `scan/` (scanner adapters, lock graph, delta scan), `guard/`, `diet/`, `freshness/`, `incident/`, `radar/`, `bisect/`, `prove/`, `evidence/` (log and pack), `vex/`, `maintainer-vex/`, `memory/`, `recipes/`, `autonomy/`, `change-request/`, `policy-nl/`, `trace/`, `hooks/`, `init/`, `jobs/`. A feature owns its types in `types.ts` and keeps test helpers in `testing/`. |
| `surfaces/` | Thin entry points that parse input, call a feature and format output: `cli/`, `mcp/`, `openapi/`, `a2a/`, and `catalog/`, where every capability is defined once as an operation (zod input, annotations, handler) and MCP tools, HTTP routes and A2A skills are generated from it. |
| `api/` | `index.ts`, the public SDK export list. |

`shared/governance/boundaries.test.ts` enforces the direction. Inside `features/`, one feature should
reach another through its `index.ts`; the imports that still reach into another feature's files are
counted by that test and may only shrink.

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

- **Patch source**: implement `PatchGenerator` (`features/patch/patch-generator.ts`) and pass it as
  `patchGenerator`, or use `createLlmPatchGenerator` with any AI SDK model.
- **Scanner format**: add an adapter under `features/scan/adapters/` returning normalized findings and
  register it in `features/scan/parse-input.ts`.
- **Intelligence source**: add a module under `features/intelligence/sources/` that returns or enriches
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
