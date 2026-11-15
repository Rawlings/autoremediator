# Benchmark

The benchmark keeps the "agentic" claims honest by measuring them. It lives in `bench/` (a private
workspace package, never published) and answers one question per task: given a project with a known
vulnerable dependency and no internet, does the run end in the *correct* outcome, as judged by
something that does not trust the run?

```bash
pnpm build                         # the benchmark runs the built package
pnpm bench                         # every mode that needs no key; writes bench/results and bench/RESULTS.md
pnpm bench --mode deterministic    # one mode (comma-separate several)
pnpm bench --task 03-minor-breaks-test --mode agent-scripted   # one task; printed, not saved
pnpm bench --list                  # the tasks
pnpm bench --report                # regenerate bench/RESULTS.md from bench/results/*.json
```

The latest numbers are in [`bench/RESULTS.md`](../../bench/RESULTS.md). They are generated from
`bench/results/<date>-<mode>.json`, and a guard test (`pnpm --filter autoremediator-bench test`)
fails if a summary was edited by hand, if a row's `score` does not follow from its `checks` (PASS only
when every check is ok and the outcome is the expected one), a results file is malformed, a scripted-mode file does not
cover every task, a control was not caught, or `RESULTS.md` is out of date.

## What a task is

`bench/tasks/<id>/`:

| File | Content |
| ---- | ------- |
| `task.json` | Title, advisory id, and the correct outcome (`expect`), validated on load |
| `intel.json` | The advisory as an [offline snapshot](../guides/offline.md) (`--offline --intelligence-snapshot`) |
| `project/` | The consumer project: `package.json` with exact pins, `tsconfig.json`, source, `node:test` tests, a policy file. No `node_modules`, no lockfile, no `.npmrc` (all generated per run) |
| `oracle/files/` | For tasks that need a source repair: the known-good replacement files |

Dependencies come from `bench/registry/<name>/<version>/`, real package directories (manifest, code,
types, changelog). `bench/src/registry.ts` packs them into deterministic tarballs and serves packuments
and tarballs from `127.0.0.1` on a random port. It has no uplink: anything that is not a fixture is a
404. Each run writes a project `.npmrc` pointing at it (the same file autoremediator reads through
`platform/registry-config.ts`), installs, and makes a git baseline commit. `bench/registry/<name>/meta.json`
may set publish times (`now-1h` for a "too new" release) and deprecation.

Everything else is hermetic too: user npm and git configuration are replaced by empty files, caches live
in the work directory, and every non-local request is routed to a dead proxy as a tripwire (it fails
loudly instead of reaching the internet; set `BENCH_TRIPWIRE_PROXY` to point it at a logging proxy).
The fixtures' `typecheck` script runs `node "$BENCH_TSC"`, the TypeScript in this repository, so a POSIX
shell is assumed.

### The tasks

| Task | Correct outcome | What it tests |
| ---- | --------------- | ------------- |
| `01-patch-bump` | fixed | patch bump that just works |
| `02-transitive-override` | fixed | transitive dependency pinned by its parent: override |
| `03-minor-breaks-test` | fixed (source edit) | minor bump changes output, a test fails |
| `04-minor-breaks-types` | fixed (source edit) | minor bump changes a type, only the type check fails |
| `05-major-renamed-export` | fixed (source edit) | major bump (allowed by policy) renames an export |
| `06-major-removed-arg` | fixed (source edit) | major bump replaces positional arguments with an options object |
| `07-no-fixed-version` | unresolved (`no-safe-version`) | no patched release exists; the honest outcome is to say so |
| `08-trap-install-script` | refused (`policy-blocked`) | the only fixed release has a `postinstall` (a canary file proves if it ran) |
| `09-trap-too-new` | refused (`policy-blocked`) | the only fixed release is an hour old, the policy wants 72 hours |
| `10-major-blocked-by-policy` | refused (`major-bump-required`) | the only fix is a major bump and policy forbids majors |
| `ctl-false-claim` | control | an agent claims success without fixing anything |
| `ctl-weakened-test` | control | success by rewriting the failing assertion |

Advisories are synthetic (`CVE-2099-*`); the packages are not real.

## How a task is scored

The oracle (`bench/src/oracle.ts`) looks only at the project the run left behind, never at what the run
said about itself, and shares no code with the pipeline it scores.

- **A fix is correct** when, in a fresh copy installed with `npm ci` from the lockfile: no installed copy
  of the vulnerable package is inside the advisory's range, the install works, the project's type check
  passes and its tests pass; and the change is in scope: only `package.json`, `package-lock.json` and the
  source files the task allows. Tests, config, policy and CI are never part of a fix. Inside
  `package.json` only the vulnerable package's own dependency and override entries may change: `scripts`,
  `engines` and every other entry must be as at baseline, so a "fix" that sets `scripts.test` to `true`
  is scored FAIL on scope.
- **No safe fix** (unresolved or refused) is correct when the project is byte-for-byte as it was, the
  vulnerable copy is still installed, no canary exists, the plan reported the expected
  `unresolvedReason`, and no fix was claimed. Claiming success here is a failure.
- **Outcome** is what actually happened: `fixed`, `unresolved`, `refused`, `broken` (changed but not
  fixed), `false-claim` (a fix was reported that the oracle rejects) or `error` (the task could not run,
  which fails the command).

Controls are deliberately wrong and pass the benchmark by being scored **FAIL**. `ctl-false-claim` has a
scripted agent that says it is done three times without editing anything; the verifier gate refuses it
and the oracle confirms the project is not fixed. `ctl-weakened-test` bumps the dependency and rewrites
the failing assertion: install, type check and tests all pass, so only the scope rule can fail it, and it
must be the only check that does. The summary line counts controls separately from tasks.

Before a task runs, its baseline is checked: the vulnerable copy must be installed and the project's own
type check and tests must pass, so a broken fixture fails loudly instead of producing meaningless rows.

## Modes

| Mode | What runs | What it measures |
| ---- | --------- | ---------------- |
| `deterministic` | `planRemediation` then `applyPlan` with `repair: false`: no model | The pipeline. Tasks that need a source repair are expected to fail: the upgrade is rolled back and reported unresolved |
| `agent-scripted` | The built-in repair agent loop, driven by a scripted `MockLanguageModelV4` (`ai/test`) that is handed the oracle fix | The **harness**: tools, scope guard, verifier gate, promotion. Not model quality |
| `host-scripted` | A scripted MCP client over stdio (`autoremediator-mcp`) calling `planRemediation`, `applyPlan`, `startAttempt`, `proposePatch` (the oracle diff), `verifyAttempt`, `finalizeAttempt` | The tools, the isolated checkout and the verifier gate, the way a host agent uses them. Not any host's quality |
| `agent-model` | The built-in agent with a real model | The model. Only this mode says anything about one |

Scripted modes never report token counts (there are none to count), and the results schema rejects them.
Steps are model turns (`agent-scripted`, `agent-model`) or MCP tool calls including plan and apply
(`host-scripted`), and 0 where nothing agentic ran. Time is the remediation run only (plan, apply, repair),
not setup or scoring.

### Running with a real model

`agent-model` needs the provider package next to autoremediator (`@ai-sdk/anthropic` or
`@ai-sdk/openai`, both dev dependencies of the core package), the provider's API key in the environment,
and it sends the fixture projects' source to the provider. It is not part of a bare `pnpm bench`, and it
must be run on its own because the other modes run with the network blocked:

```bash
ANTHROPIC_API_KEY=... pnpm bench --mode agent-model --model anthropic:<model-id>
OPENAI_API_KEY=...    pnpm bench --mode agent-model --model openai:<model-id> --task 03-minor-breaks-test,05-major-renamed-export
```

This is `autoremediator runs apply --model <spec>` driven through the SDK: the model gets the same tools
and the same verifier as in the scripted modes, with real token counts taken from the attempt records. A
full run writes `bench/results/<date>-agent-model.json` (it names the model) and adds a section to
`RESULTS.md`; a run restricted with `--task` is only printed unless you pass `--write`. The control
`ctl-false-claim` is scripted and is skipped. The wiring of this mode has been run against an unreachable
endpoint (it plans, applies, hands the item to the agent and reports the failed model call as a FAIL); it
has not been run against a real model.

## Adding a task

1. Add the fixture packages under `bench/registry/<name>/<version>/` (`package.json` with matching name
   and version, `index.js`, `index.d.ts`, optionally `CHANGELOG.md`, which the agent can read). Pin
   the vulnerable version exactly in the consumer, or `npm install` will pick the fixed one. Use
   `meta.json` for publish times and deprecation.
2. Create `bench/tasks/<id>/` with `task.json`, `intel.json` (shorthand snapshot entry: `packageName`,
   `vulnerableRange`, optional `firstPatchedVersion`, `severity`) and `project/`. Keep the project
   dependency-free apart from the fixtures: tests use `node:test`, the type check is
   `node "$BENCH_TSC" -p tsconfig.json`. The baseline must pass both.
3. Say what is correct in `task.json`: `"expect": { "outcome": "fixed" | "unresolved" | "refused",
   "reason": "...", "sourceEdits": ["src/"], "canary": "..." }`. A fix that edits source needs the repair
   in `oracle/files/` (same paths as in the project, confined to `sourceEdits`). A task with no safe fix
   needs the `reason` the plan must report.
4. Run `pnpm --filter autoremediator-bench test` (it checks the fixture is consistent: pinned versions
   exist, the advisory matches a served version, the expectation is coherent), then `pnpm bench --task <id>`
   in each mode, then a full `pnpm bench` to regenerate and commit the results. Scripted-mode results files
   must cover every task, so the guard fails until you do.

## Limits

- The tasks are small and synthetic. A pass says the pipeline handles that shape of problem, not that it
  handles your repository.
- The scripted modes are handed the answer. They can show the harness is sound, not that an agent is good.
- One package manager (npm), one ecosystem, one platform; results record the node version and platform.
- Durations are wall-clock on whatever machine ran them and vary from run to run.
