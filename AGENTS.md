# Autoremediator: contributor charter

Autoremediator fixes vulnerable dependencies: it plans a fix, applies it, verifies it, and rolls it
back if verification fails. It runs as an SDK, a CLI, an MCP server, an HTTP server and an A2A
agent. What each mode does, with triggers and source paths, is in
[docs/reference/modes.md](docs/reference/modes.md). This file is about how to write code here.

## The wanted state

Six principles. Each has a skill with the detail; this is the part to remember.

1. **Organised by feature.** Everything one capability needs lives in one folder. A reader finds a
   feature by name, not by knowing which layer it was filed under. (`code-structure`)
2. **Parse at the boundary, trust inside.** Data from disk, the network, a model or a caller is
   `unknown` until a schema has parsed it. We do not cast it. (`boundaries-and-errors`)
3. **Errors are typed and never silently swallowed.** Expected failures are values; unexpected ones
   throw a typed error; a catch either handles the error or says why ignoring it is safe.
   (`boundaries-and-errors`)
4. **One way to do each thing.** One helper for the error message, one for reading JSON, one verb for
   each kind of function, one way to write an optional property. Before writing a helper, look in
   `shared/`. (`code-style`)
5. **Small files, small functions, read top-down.** Files under 400 lines, functions under 80,
   exports before helpers, no nested ternaries, braces whenever an `if` spans lines.
   (`code-style`, `code-structure`)
6. **Surfaces are thin.** CLI, MCP, HTTP and A2A parse input, call a feature and format output. They
   hold no domain logic. (`code-structure`)

Beyond the six: **reuse, then refactor, then create.** Look for an existing home before adding a
file, and say why when you add one. Fail loudly on invalid input; no silent fallbacks to defaults.

## Where things go

```
packages/core/src/
  index.ts          the public SDK, one curated export list
  shared/           tiny kernel: errors, JSON and fs helpers, hashing, text, env
  infra/            http, auth, locks, jobs, package managers, policy loading
  features/<name>/  one folder per capability: entry, logic, its types, tests, fixtures
  surfaces/         cli, mcp, openapi, a2a, catalog
```

Dependencies point one way: `surfaces -> features -> infra -> shared`, and features reach each other
only through each other's `index.ts`. The code is being moved to this layout feature by feature; the
plan and the mapping from today's folders are in
[docs/contributing/target-structure.md](docs/contributing/target-structure.md), and the measured
starting point is [docs/contributing/code-quality-audit.md](docs/contributing/code-quality-audit.md).
Until a feature has moved, follow its current folder, but put new shared helpers in `shared/` and
new features under `features/`.

## Commands

```bash
pnpm build:all       # tsc for every package
pnpm lint            # oxlint, type-aware, warnings fail
pnpm format:check    # oxfmt (pnpm format to fix)
pnpm typecheck:all
pnpm test:all        # vitest
pnpm bench           # offline benchmark, see docs/contributing/benchmark.md
node scripts/quality-metrics.ts   # code quality baseline; the numbers only go down
```

## Skills

Contributor skills live in `.github/skills/` (mirrored to `.claude/skills/` for Claude Code; a test
fails if the copies drift). Load the one that matches the work:

| Skill | Use when |
|---|---|
| `code-structure` | adding, moving or splitting files; deciding where code belongs; imports |
| `code-style` | writing or reviewing any TypeScript: layout of a file, naming, size |
| `boundaries-and-errors` | reading files, network or model output; throwing, catching, returning failures |
| `public-api-governance` | exported names, option and result shapes, SDK/CLI/MCP/HTTP parity |
| `mcp-tool-registration` | adding or changing an operation in the catalog |
| `feature-implementation`, `test-governance` | feature work end to end; where and how to test |
| `evidence-ci-reporting`, `changeset-writing`, `governance-check` | reports and exit codes; changesets; docs and governance sync |

The runtime skills (`agent-orchestration`, `cve-intelligence-sources`, `semver-remediation`,
`patch-generation-strategy`, `safety-validation-gates`, `scanner-parser-integration`) describe how
the tool executes; read them when changing remediation behaviour.

## How work is delivered

Feature work, refactors and architecture-affecting tasks follow the planner/developer handoff in
[.github/copilot-instructions.md](.github/copilot-instructions.md) (agents in `.github/agents/`).
That file is canonical for handoff stages, packet requirements and the cross-surface touchpoint
gate. Instruction files in `.github/instructions/` carry the runtime tool order and safety rules.

## Public API naming canon

Across SDK, CLI mapping, MCP, and OpenAPI, use these canonical terms and do not introduce synonym
fields for them: `runTests`, `policy`, `evidence`, `patchCount`, `patchesDir`,
`offlineIntelligence`, `intelligenceSnapshotPath`, `proofOfFix`, `requireProofOfFix`,
`breakingChangeRefactor`. Patch lifecycle operations: `listPatchArtifacts`,
`inspectPatchArtifact`, `validatePatchArtifact`, `reconcilePatchArtifacts`. Precedence of options
(CLI/API, then policy file, then tool contracts, then defaults) is in
[docs/reference/modes.md](docs/reference/modes.md).

## Changesets and documentation

- **Never edit `CHANGELOG.md` directly.** Release notes come only from changesets
  (`.changeset/<name>.md`), with the semver bump (`patch`, `minor`, `major`).
- **Document every change** to an API, CLI command, MCP tool, option or runtime behaviour: the page
  in `docs/` (indexed by `docs/README.md`; see
  `.github/instructions/documentation-governance.instructions.md`), the package READMEs, the
  matching entry in `docs/reference/modes.md`, and a changeset.
