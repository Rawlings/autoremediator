# Modes and runtime behaviour

Contributor-facing reference for every way Autoremediator runs: each mode's trigger, behaviour and
source location, the precedence of options, the autonomous-defense controls and the fallback
policy. It used to be the body of the root `AGENTS.md`; that file is now a short contributor
charter and links here. For using the tool, start at [Getting started](../getting-started.md).

When you add or change an operation, update the matching entry here (and the MCP tool and HTTP
route lists in the Mode 4 and Mode 5 entries).

## Modes

### Mode 1: Direct CVE & GHSA

- Trigger: `autoremediator CVE-YYYY-NNNNN` or `autoremediator GHSA-xxxx-xxxx-xxxx`, `remediate(cveId, options)`, or `planRemediation(cveId, options)`
- Behavior: single-vulnerability remediation pipeline supporting standard CVE and GHSA identifiers
- Instruction set:
  - .github/instructions/orchestration.instructions.md
  - .github/instructions/agent-safety.instructions.md
  - .github/instructions/tool-contracts.instructions.md

### Setup: `autoremediator init`

- Trigger: `autoremediator init [--hosts a,b] [--ci] [--yes|--check]` or `init(options)` (CLI and SDK only; deliberately not an MCP tool or HTTP route, because it writes configuration)
- Behavior: detects package manager, git host, CI and agent hosts; merges the MCP server entry into each host's config, writes the policy file, `.gitignore` entry, agent skills/rules/custom agent and an `AGENTS.md` section; never replaces an existing `autoremediator` entry; needs `--yes` when not interactive (otherwise exits `3`)
- Source: `packages/core/src/api/init/`; the Claude Code plugin under `plugins/claude-code/` is generated from the same text (`UPDATE_PLUGINS=1 pnpm --filter autoremediator test plugin-files`)

### Guard: `autoremediator guard <pkg...>`

- Trigger: `autoremediator guard <spec...>`, `guardPackage(spec, options)` (MCP tool and `POST /packages/guard` too), `guard --git-diff` (dependencies added since a git ref), or the `guard-hook --host claude-code|cursor|copilot` pre-command hook (`init --guard` writes the host's hook file and a `.pnpmfile.cjs` for pnpm; the Claude Code plugin ships its own)
- Behavior: judges a package before install (existence, OSV malware, look-alike names, release age, install scripts, provenance, vulnerabilities) as `allow`/`warn`/`block`; lookup failures warn; exit `0`/`3`/`4`; the hook is a guard rail for plain install commands, not a security boundary
- Source: `packages/core/src/api/guard/`

### Git hooks: `autoremediator hook install|uninstall|status`

- Trigger: `autoremediator hook <install|uninstall|status> [--hooks pre-push,post-merge] [--manager ...] [--yes]` or `installHooks(options)` (CLI and SDK only; deliberately not an MCP tool or HTTP route, because it writes files that run on every push)
- Behavior: detects husky, lefthook, the pre-commit framework or plain git hooks; writes a marked block or named entry per hook and never overwrites what it cannot merge (reported as a conflict); `pre-push` runs `diff --ci` against the upstream only when a manifest or lockfile changed and blocks only on a DEGRADED verdict; `post-merge` prints a one-line advisory and never fails; skip with `AUTOREMEDIATOR_SKIP_HOOKS=1`; exits `3` when not confirmed, `status` exits `1` on drift
- Source: `packages/core/src/api/hooks/`

### Earned autonomy: `autoremediator autonomy status|explain`

- Trigger: policy key `autonomy: { ceiling: L0..L4, ... }`, `getAutonomy` (MCP, `POST /autonomy`, SDK), `autonomy status|explain`
- Behavior: the level in force is min(policy ceiling, level earned from the committed track record `.autoremediator/track-record.json`); a rollback or verifier failure demotes immediately; below L2 apply, resume, finalize and non-dry `remediate` refuse; L3/L4 only set `autoMergeEligible`/`escalate` signals (no auto-merge exists); the key is policy-file only, never settable by a caller
- Source: `packages/core/src/autonomy/`, `packages/core/src/api/autonomy/`; guide `docs/guides/earned-autonomy.md`

### Recipes: `autoremediator recipes list|show|capture|export`

- Trigger: accepted agent repairs are captured as data-only recipes; `listRecipes`, `applyRecipe` (MCP/HTTP/SDK), `recipes ...` (CLI); policy key `recipes.packages`
- Behavior: exact-context hunks only, fail closed on drift, same validation as `proposePatch`, then the verifier; tried before an agent attempt; never executable code
- Source: `packages/core/src/recipes/`, `packages/core/src/remediation/repair/recipe-attempt.ts`; guide `docs/guides/recipes.md`

### Runtime reachability: `autoremediator trace run`

- Trigger: `autoremediator trace run [--packages a,b] [--calls] -- <command>`, `traceRun` (CLI and SDK only: runs arbitrary commands), `checkReachability` with `traceFile`; hook export `autoremediator/trace`
- Behavior: records which dependencies are loaded (and, opt-in, which exported functions are called) while tests run; a runtime verdict is evidence, never proof of unreachability
- Source: `packages/core/src/trace/`; guide `docs/guides/runtime-reachability.md`

### Upgrade impact: `assess`, `symbols`

- Trigger: `assessUpgrade`, `findVulnerableSymbols` (MCP, HTTP, SDK), `autoremediator assess|symbols`
- Behavior: compares two versions' public API against the project's own usage (High/Medium/Low with file:line sites); lists exports a fix changed as heuristic candidate vulnerable symbols
- Source: `packages/core/src/remediation/impact/`; guide `docs/guides/upgrade-impact.md`

### Incident response: `autoremediator incident`, `autoremediator premortem`

- Trigger: `incident <id|pkg@range>`, `premortem`, matching MCP tools, `POST /incident`, `POST /premortem`, SDK
- Behavior: exposure and lockfile-history windows, a rollback plan held for approval (never auto-applied), a secrets rotation checklist (names only, never values); pre-mortem playbooks across repos
- Source: `packages/core/src/api/incident/`, `packages/core/src/scanner/lock-graph/`; guide `docs/guides/incident-response.md`

### Lockfile bisect: `autoremediator bisect`

- Trigger: `bisect --good <ref> --command "<cmd>"`, `bisectLockfile` (CLI and SDK only: runs an arbitrary command)
- Behavior: delta-debugs the lockfile diff in isolated worktrees to the culprit package(s); returns evidence and a pin-back plan (applied only with `--apply`); exits 0 found, 1 otherwise, 130 interrupted
- Source: `packages/core/src/api/bisect/`; guide `docs/guides/bisect.md`

### Dependency diet: `autoremediator diet [--apply]`

- Trigger: `analyzeDependencies` (MCP, `POST /packages/diet`, SDK, read-only), `diet`, `diet --apply` / `removeUnusedDependencies` (CLI and SDK only; writes)
- Behavior: unused (certainly/probably/used-indirectly), Node-built-in-replaceable, duplicate versions, 0-100 attack-surface score; `--apply` removes only certainly-unused, verifies, rolls back on failure
- Source: `packages/core/src/api/diet/`; guide `docs/guides/dependency-diet.md`

### Benchmark: `pnpm bench`

- `bench/` (private workspace package) runs fixture tasks offline against a local registry in `deterministic`, `agent-scripted`, `host-scripted` modes (and a documented real-model mode that has never been run); results in `bench/RESULTS.md`; scripted modes measure the harness, not model quality. See `docs/contributing/benchmark.md`.

### Evidence pack: `autoremediator evidence-pack`

- Trigger: `evidence-pack --out <dir>`, `buildEvidencePack` (MCP, `POST /evidence-pack`, SDK), `evidence-pack verify` (CLI and SDK only)
- Behavior: from local data only, writes a CycloneDX 1.6 SBOM, CycloneDX and OpenVEX VEX, CRA Article 14 report drafts for KEV-listed advisories (marked DRAFT, deadlines from a supplied awareness time), and DSSE/in-toto attestations of recorded runs (signed only with a key file); labelled evidence assembly, not legal advice
- Source: `packages/core/src/api/evidence-pack/`; guide `docs/guides/evidence-pack.md`

### Exploit-proof evidence: `autoremediator prove`

- Trigger: `prove <CVE|GHSA> --package <name>`, `generateProofOfFix` (MCP, `POST /proof-of-fix/generate`, SDK); needs a model
- Behavior: an agent proposes a reproduction script; it is kept only if the harness shows it fails on the vulnerable version and passes on the fixed one, run in a verified permission-model sandbox; writes `patches/<pkg>+<ver>.test.cjs` and an evidence record (optionally DSSE-signed)
- Source: `packages/core/src/api/prove/`; guide `docs/guides/proof-of-fix-generation.md`

### Silent-fix radar: `autoremediator radar`

- Trigger: `radar`, `radar` (MCP, `POST /radar`, SDK)
- Behavior: flags releases between the installed and a newer version that look security-relevant (changelog, code diff, metadata) with no published advisory; never states a vulnerability exists; cross-checks OSV
- Source: `packages/core/src/remediation/radar/`, `packages/core/src/api/radar/`; guide `docs/guides/silent-fix-radar.md`

### Maintainer VEX: `autoremediator maintain`, `autoremediator vex show`

- Trigger: `readMaintainerVex` (MCP, `POST /maintainer-vex`, SDK), `vex show`, `maintain` (CLI and SDK only; writes); policy key `trustMaintainerVex`
- Behavior: reads OpenVEX documents shipped in installed packages (`package.json#vex`) as evidence, suppressing remediation only when the policy opts in; `maintain` prepares a bump plan, changeset and the package's own VEX for review (`--yes` to write); never publishes or pushes
- Source: `packages/core/src/platform/maintainer-vex/`, `packages/core/src/api/maintain/`; guide `docs/guides/maintainer-vex.md`

### Dependency freshness: `autoremediator freshness`

- Trigger: `freshnessReport`, `planFreshnessStep` (MCP, `POST /freshness`, `POST /freshness/plan`, SDK), `freshness --apply` / `applyFreshness` (CLI and SDK only); policy key `freshness`
- Behavior: distance report and score; policy-limited climb in one-jump steps ordered by `assessUpgrade`; each step is its own recorded run applied through `applyPlan`, rolled back on failure, gated by autonomy
- Source: `packages/core/src/api/freshness/`; guide `docs/guides/freshness.md`

### Remediation memory: `autoremediator memory`

- Trigger: `listMemory` (MCP, `POST /memory/list`, SDK, resource `autoremediator://memory`); `memory add|accept|remove|prune` (CLI and SDK only); `--ignore-memory` (SDK and CLI only, never on the wire)
- Behavior: committed `.autoremediator/memory.md`; pins and rejected upgrades constrain the planner, a test command fills gaps only, agent proposals wait for `memory accept`, auto-recording only from verified evidence
- Source: `packages/core/src/platform/memory/`; guide `docs/guides/memory.md`

### Policy in plain language: `autoremediator policy compile|explain`

- Trigger: `compilePolicy` (proposal only, needs a model), `explainPolicy` (MCP, `POST /policy/compile`, `POST /policy/explain`, SDK), `policy compile|explain` (CLI)
- Behavior: a model proposes a patch of allowlisted keys; code validates it with the real policy schema, rejects unrequested loosening, shows a diff, and writes only with `--yes`
- Source: `packages/core/src/api/policy-nl/`; guide `docs/guides/policy-in-plain-language.md`

### Mode 2: Scan & Delta Input

- Trigger: `autoremediator <scan-file>`, `autoremediator diff`, `autoremediator triage`, or `remediateFromScan(inputPath, options)`
- Behavior: parse scanner findings or lockfile diffs, deduplicate CVE/GHSA advisories, triage interactively or batch-remediate
- Instruction set: Mode 1 + scanner parser skill

### Mode 2b: Portfolio Input

- Trigger: `autoremediator portfolio --targets-file <json>` or `remediatePortfolio(targets, options?)`
- Behavior: run Mode 1 or Mode 2 across multiple repository targets and aggregate per-target outcomes
- Instruction set: Mode 2 + contributor API-surface rules for the portfolio contract

### Mode 3: CI

- Trigger: `--ci`
- Behavior: non-interactive output, deterministic summary and exit code (`0` ok, `1` failed, `2` partial, `3` waiting for approval, `4` blocked by policy; `EXIT_CODES` in the SDK); `slaBreachSummary` appears in scan/portfolio output when `--sla-check` is enabled and at least one CVE exceeds its SLA window
- Instruction set: Mode 2 + evidence/ci skill

### Mode 4: MCP Tool Server

- Trigger: `autoremediator-mcp` (stdio), or `autoremediator-mcp --http` (stateless streamable HTTP on `127.0.0.1`, role-gated; see `docs/integrations/mcp-server.md`)
- Behavior: exposes every operation in the catalog (`packages/core/src/catalog`) as an MCP tool, generated from one definition shared with the HTTP server
- Source: `packages/core/src/catalog/`, `packages/core/src/mcp/` (server, resources, prompts, HTTP transport)
- Exposed MCP tools: `health`, `remediate`, `planRemediation`, `remediateFromScan`, `remediatePortfolio`, `listPatchArtifacts`, `inspectPatchArtifact`, `validatePatchArtifact`, `reconcilePatchArtifacts`, `applyPlan`, `resumeRun`, `rollbackRun`, `verifyRun`, `startAttempt`, `proposePatch`, `verifyAttempt`, `finalizeAttempt`, `abandonAttempt`, `getRun`, `listRuns`, `updateOutdated`, `toVex`, `submitRemediateJob`, `submitScanJob`, `submitPortfolioJob`, `pollJob`, `checkReachability`, `evaluatePackage`, `guardPackage`, `getAutonomy`, `analyzeDependencies`, `scanDelta`, `listRecipes`, `applyRecipe`, `assessUpgrade`, `findVulnerableSymbols`, `incident`, `premortem`, `compilePolicy`, `explainPolicy`, `readMaintainerVex`, `generateProofOfFix`, `radar`, `freshnessReport`, `planFreshnessStep`, `listMemory`, `buildEvidencePack`

### Mode 5: OpenAPI HTTP Server

- Trigger: `node dist/openapi/server.js [--port 3000]`
- Behavior: POST `/remediate`, POST `/plan-remediation`, POST `/remediate-from-scan`, POST `/remediate-portfolio`, POST `/patches/list`, POST `/patches/inspect`, POST `/patches/validate`, POST `/patches/reconcile`, POST `/runs/apply`, POST `/runs/resume`, POST `/runs/rollback`, POST `/runs/verify`, POST `/attempts/start`, POST `/attempts/patch`, POST `/attempts/verify`, POST `/attempts/finalize`, POST `/attempts/abandon`, POST `/runs/get`, POST `/runs/list`, POST `/update-outdated`, POST `/vex`, POST `/jobs/remediate`, POST `/jobs/scan`, POST `/jobs/portfolio`, GET `/jobs/:jobId`, POST `/reachability`, POST `/packages/evaluate`, POST `/packages/guard`, POST `/autonomy`, POST `/packages/diet`, POST `/delta-scan`, POST `/recipes/list`, POST `/attempts/recipe`, POST `/packages/assess-upgrade`, POST `/packages/vulnerable-symbols`, POST `/incident`, POST `/premortem`, POST `/policy/compile`, POST `/policy/explain`, POST `/maintainer-vex`, POST `/proof-of-fix/generate`, POST `/radar`, POST `/freshness`, POST `/freshness/plan`, POST `/memory/list`, POST `/evidence-pack`, public `GET /.well-known/agent-card.json` (A2A Agent Card), `POST /a2a` (A2A 1.0 JSON-RPC: `SendMessage`, `GetTask`; bearer auth, role per operation; see `docs/integrations/a2a.md`) over HTTP on `127.0.0.1` (auth required unless `AUTOREMEDIATOR_INSECURE_NO_AUTH=1`; see `docs/integrations/http-server.md`)
- Source: `packages/core/src/openapi/server.ts` (routes and OpenAPI document generated from `packages/core/src/catalog/`); `packages/core/src/a2a/` (Agent Card builder, signing, `/a2a` endpoint). A2A skills are a curated subset of the catalog (`A2A_SKILL_NAMES` in `a2a/agent-card.ts`): adding a catalog operation does not publish it over A2A automatically


## Precedence

1. Explicit CLI/API options
2. Policy file (`.github/autoremediator.yml`)
3. Tool contracts
4. Default behavior

## Autonomous Defense Controls

These runtime controls are additive across the public surfaces described above:

- `dispositionPolicy`: classifies each remediation result as `auto-apply`, `simulate-only`, `hold-for-approval`, or `escalate` using confidence, transitive scope, KEV, and SLA signals.
- `containmentMode`: rolls back applied results whose disposition is `hold-for-approval` (low confidence or held transitive changes), rewriting them to unresolved `policy-blocked` outcomes so they wait for approval. Urgent `escalate` results (KEV, SLA breach) stay applied and are escalated instead.
- `escalationGraph`: maps unresolved reasons to intended follow-up actions such as `open-issue`, `notify-channel`, `create-draft-pr`, or `hold-branch`.
- `campaignMode`: risk-ranks portfolio targets using `riskHint` signals and returns `threatRank` on each portfolio result.
- `simulationMode`: dry-run and preview only; adds planned mutation metadata, rebuttal findings, and aggregate `simulationSummary` output.
- `proofOfFix`: enforces dual-stage verification (negative test pre-mutation must fail, positive test post-mutation must pass).
- `breakingChangeRefactor`: AST-guided consumer call-site codemod repair when version upgrades introduce breaking API changes.

Aggregate reporting fields produced by these controls include `dispositionCounts`, `escalationCounts`, `simulationSummary`, and `proofOfFixCount`.

Patch lifecycle operation naming canon:

- `listPatchArtifacts`
- `inspectPatchArtifact`
- `validatePatchArtifact`
- `reconcilePatchArtifacts`

## Fallback Policy

When a safe version exists but the vulnerable package is transitive:

1. apply-package-override using package-manager-native fields
2. only fall back to patch generation if override remediation cannot be applied

When no safe version exists:

1. fetch-package-source
2. generate-patch
3. apply-patch-file

If patch confidence is low or validation fails, result must be marked as unresolved and evidence must include reason.
