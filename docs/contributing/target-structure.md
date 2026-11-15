# Target structure for `packages/core/src`

**Status: draft for review (Phase 1 of the code quality turnaround).** Nothing has been moved yet.
The audit that motivates this is in [code-quality-audit.md](code-quality-audit.md); the numbers come
from `node scripts/quality-metrics.ts`.

## Why change the layout

Today the code is grouped by *layer* (`api/`, `platform/`, `remediation/`, `runs/`...). One feature
therefore lives in two or three places (`api/runs` + `runs/`, `api/memory` + `platform/memory`,
`api/radar` + `remediation/radar`), `platform/` holds domain code, and `platform/types.ts` (928
lines, imported by 164 files) is the type dumping ground. A contributor has to know the layering
history to find anything.

The layering itself is sound and should be kept as a dependency rule: `platform/` imports nothing
else, nothing below `api/` imports `api/`, `cli/`, `mcp/` or `openapi/`, and the only top-level
cycle is `remediation <-> scanner` (one import each way). The refactor changes where files *live*,
not which way dependencies point.

## Target tree

```
packages/core/src/
  index.ts              the public SDK: one curated export list (replaces api/index.ts)
  shared/               tiny kernel, no domain knowledge, imports nothing from the repo
  infra/                machinery every feature uses: http, auth, locks, jobs, package managers, policy loading
  features/<name>/      one folder per capability: everything it needs in one place
  surfaces/             thin adapters that expose features: cli, mcp, openapi, a2a, catalog
```

Dependency direction, enforced by `boundaries.test.ts` and `import/no-cycle`:

```
surfaces  ->  features  ->  infra  ->  shared
```

- A feature imports another feature only through that feature's `index.ts`.
- A feature never imports `surfaces/`.
- `shared/` and `infra/` never import `features/`.

### What a feature folder looks like

```
features/diet/
  index.ts          the feature's public face: a list of exports, no logic
  analyze.ts        the main operations, one verb per file once a file passes ~300 lines
  apply.ts
  types.ts          this feature's types and zod schemas, only what it owns
  diet.test.ts      tests sit next to the code they cover
  fixtures/         test data used only by this feature
```

Rules of thumb (the skills will carry the details): a feature starts as one file; it becomes a
folder when it has two or more files; `index.ts` only re-exports; no file over 400 lines; no
function over 80 lines.

## Where everything goes (folder granularity)

### `shared/` (new, small)

| From | To |
|---|---|
| `platform/trim.ts`, `platform/redact.ts`, `platform/package-name.ts`, `platform/path-guard.ts`, `platform/git-ref.ts`, `platform/timeouts.ts`, `platform/entrypoint.ts` | `shared/` (text, guards, paths) |
| `platform/safe-exec.ts`, `platform/safe-exec-command.ts` | `shared/exec/` |
| `runs/hash.ts`, `runs/ids.ts` and the six scattered `sha256`/`sleep`/`toPosix`/`isRecord` copies | `shared/` |
| (new) `errors.ts`, `json.ts` (`readJsonFile(path, schema)`), `fs.ts`, `text.ts` (`plural`, `errorMessage`) | `shared/` |
| `platform/config.ts` and the 16 `process.env` reads | `shared/env.ts` (one typed reader) |

### `infra/` (what `platform/` was meant to be)

| From | To |
|---|---|
| `platform/http-auth.ts`, `http-client.ts`, `http-security.ts`, `registry-config.ts` | `infra/http/` |
| `platform/jobs.ts`, `idempotency.ts`, `repo-lock.ts` | `infra/jobs/` |
| `platform/package-manager/` and `package-manager.test.ts`, `workspace.ts`, `cooldown.ts` | `infra/package-manager/` |
| `platform/policy.ts`, `freshness-policy.ts`, `option-schemas.ts` | `infra/policy/` (loading and validating the policy file and option schemas) |
| `platform/supply-chain.ts` | `features/guard/` (it is domain logic, used by guard and evaluate) |

### `features/` (one folder per capability)

| Feature | Absorbs |
|---|---|
| `remediate/` | `api/remediate`, `api/remediate-from-scan`, `api/portfolio`, `api/scan-execution.ts`, `api/scan-outcome.ts`, `api/reporting.ts`, `api/sarif.ts`, `remediation/local/` |
| `runs/` | `api/runs/` + `runs/` (ledger, store, plan, worktree, fingerprint, snapshots), `platform/rollback.ts` |
| `attempts/` (name to decide) | `remediation/repair/`, `platform/repair-agent.ts`, the `api/runs` attempt operations |
| `patch/` | `remediation/patch/`, `remediation/strategies/`, `remediation/tools/apply-patch-file/`, `api/patches/`, `platform/patch-generator.ts` |
| `override/` | `remediation/tools/apply-package-override/` |
| `verify/` | `remediation/verify/`, `remediation/proof-of-fix/` |
| `refactor/` | `remediation/refactor/` (codemods, call-site finder) |
| `impact/` | `remediation/impact/`, `api/assess/` (assess, symbols) |
| `reachability/` | `remediation/tools/check-reachability.ts`, `api/reachability/`, `trace/`, `api/trace/` |
| `intelligence/` | `intelligence/sources/`, `api/evaluate/`, `remediation/evaluate-package.ts` |
| `scan/` | `scanner/` (adapters, lock-graph, delta-scan), `api/delta-scan/` |
| `guard/` | `api/guard/`, `platform/supply-chain.ts` |
| `diet/` | `api/diet/` |
| `freshness/` | `api/freshness/`, `api/update-outdated/` |
| `radar/` | `api/radar/`, `remediation/radar/` |
| `incident/` | `api/incident/`, `api/premortem/` |
| `bisect/` | `api/bisect/` |
| `prove/` | `api/prove/` |
| `recipes/` | `recipes/`, `api/recipes/` |
| `memory/` | `platform/memory/`, `api/memory/` |
| `maintainer-vex/` | `platform/maintainer-vex/`, `api/maintainer-vex/`, `api/maintain/` |
| `vex/` | `api/vex/`, the VEX parts of `api/remediate.evidence.ts` |
| `evidence/` | `api/evidence-pack/`, `platform/evidence.ts`, `api/remediate.evidence.ts` |
| `autonomy/` | `autonomy/`, `api/autonomy/` |
| `change-request/` | `api/change-request/` |
| `disposition/` | `platform/escalation.ts`, `platform/policy-loosening.ts`, containment and disposition logic |
| `policy-nl/` | `api/policy-nl/` |
| `init/`, `hooks/` | `api/init/`, `api/hooks/` |

`platform/types.ts` is split by owner: each type moves into the feature that defines it (`PatchResult`
to `patch/`, `RemediationReport` to `remediate/`, `AutonomyState` to `autonomy/`, and so on). Types
used by three or more features go to `shared/types.ts`; the aim is under 15 of them.

### `surfaces/`

| From | To |
|---|---|
| `cli/program.ts` (905 lines), `cli/runners.ts` (1,407 lines) and the `*-commands.ts` files | `surfaces/cli/commands/<feature>.ts`, one per feature, plus a small `program.ts` that registers them |
| `cli/output.ts`, `cli/result-lines.ts`, `cli/errors.ts`, `cli/validators.ts` | `surfaces/cli/` (one `emitReport` helper for format and exit code) |
| `catalog/` | `surfaces/catalog/` with one `<feature>-operations.ts` per feature (the pattern 13 files already follow); `operations.ts` (929 lines) is split into them |
| `mcp/`, `openapi/`, `a2a/` | `surfaces/mcp/`, `surfaces/openapi/`, `surfaces/a2a/` |

## The package entry points

`package.json#exports` keeps its five entries. Only the file behind `.` moves: `dist/api/index.js`
becomes `dist/index.js`. `./cli`, `./mcp`, `./openapi` and `./trace` keep their subpath names.

## Open questions for the review gate

1. **Granularity of the engine split.** The audit's evidence is that `remediation/` (65 files, 15.6k
   lines) is a set of separate capabilities (impact, patch, repair, verify, refactor). The table above
   makes each its own feature. The alternative is one big `features/remediate/` with subfolders; it is
   fewer moves but recreates a 20k-line grab-bag.
2. **Adapters beside the feature, or in `surfaces/`?** A vertical slice would put each feature's CLI
   command and catalog operation inside its own folder. This tree keeps them in `surfaces/` so the
   dependency direction stays one-way and a surface can be read as a whole; the cost is that adding
   an option still touches the feature plus up to three surface files. The two layouts use the same
   file names, so a later move is mechanical.
3. **`api/` as a name.** Dropping it means every import path in docs, the changeset history and the
   github-app's deep imports (if any) change. Tracked as a breaking-change item in Phase 3 step 7.
4. **Generate the CLI from the catalog?** The audit shows the CLI is the one surface that is not
   generated, which is why options and descriptions drift. Deriving flags from the catalog's zod
   schemas would remove most of that duplication but is a design project of its own. Proposal: not
   in this refactor; first put one `emitReport` helper and one command file per feature in place,
   and add a parity test for every command (today only `cve` has one).
5. **`e2e/` imports internals by path.** 14 files import about 17 internal modules, and CI does not
   run `e2e/`. Every folder move breaks them silently. Proposal: wire `e2e/` into CI (or at least
   typecheck it) before the first move, and make the feature moves update its imports in the same PR.
6. **Brace style.** The code has 1,627 single-line brace-less `if`s and 169 multi-line ones. The
   plan said "always braces"; ESLint-style `curly: multi-line` (braces required unless the whole
   `if` fits on one line) would remove all the multi-line cases without touching the other 1,627.
