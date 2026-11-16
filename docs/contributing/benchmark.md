# Benchmark

The benchmark keeps the "agentic" claims honest by measuring them. It lives in `packages/bench/` (a private
workspace package, never published) and answers one question per task: given a project with a known
vulnerable dependency and no internet, does the run end in the *correct* outcome, as judged by
something that does not trust the run?

```bash
pnpm build                         # the benchmark runs the built package
pnpm bench:corpus restore          # once per checkout: download the pinned package tarballs (about 30 MB), verified against corpus/lock.json
pnpm bench                         # every mode that needs no key; writes packages/bench/results/<mode>.json and every generated page
pnpm bench --mode deterministic    # one mode (comma-separate several)
pnpm bench --task 03-minor-breaks-test --mode agent-scripted   # one task; printed, not saved
pnpm bench --list                  # the tasks
pnpm bench --report                # regenerate the pages from packages/bench/results/*.json
```

## Where the results are

The numbers are in [`packages/bench/RESULTS.md`](../../packages/bench/RESULTS.md), an overview that leads
with what was measured, where the pipeline stops and what the numbers do not show. It links to a page per mode
(`results/<mode>.md`) and a [task catalogue](../../packages/bench/results/tasks.md). The root README quotes a
few of the figures. All of it is generated from `packages/bench/results/<mode>.json`: files are named by mode only
(the date is inside the file, and git keeps the history), so a new run replaces the old one in place.

A guard test (`pnpm --filter autoremediator-bench test`) fails if any generated page or the README figures
differ from what the data produces, if a summary was edited by hand, if a row's `score` does not follow from its
`checks` (PASS only when every check is ok and the outcome is the expected one), if a results file is malformed,
if a scripted-mode file does not cover every task, or if a control was not caught. Every figure on a page comes
from `src/report/metrics.ts`, which reads only the results files.

## Two kinds of task

- **Corpus tasks** are built from a published npm release and the published advisory for it. The advisory is stored
  as OSV publishes it, and the packages are served with the registry's own integrity hashes.
- **Harness tasks** are purpose-built fixtures for cases that cannot come from published data: a release published
  an hour ago, an install-script trap, an invented advisory (`CVE-2099-*`).

Results keep the two apart, and the headline figures use corpus tasks whenever there are any.

## What a task is

`packages/bench/tasks/<id>/`:

| File | Content |
| ---- | ------- |
| `task.json` | Title, advisory id, `origin` (`corpus` or `harness`), `dimension` (the kind of problem), and the correct outcome (`expect`), validated on load. A corpus task also names its `package` and its `osv` record, and may set `baseline.before` to resolve its lockfile as it would have been on that date |
| `intel.json` | The advisory as an [offline snapshot](../guides/offline.md) (`--offline --intelligence-snapshot`). For a corpus task it is generated from the stored OSV record by `pnpm bench:corpus freeze`, and a test fails if it differs |
| `project/` | The consumer project: `package.json` with exact pins (stored as `package.json.fixture` for a corpus task: its dependencies are deliberately vulnerable, and under the name `package.json` GitHub's dependency graph, Dependabot and dependency review would treat them as this repository's own; the harness restores the name when it builds the project), `tsconfig.json`, source, `node:test` tests, a policy file. No `node_modules`, no lockfile, no `.npmrc` (all generated per run) |
| `oracle/files/` | For tasks that need a source repair: the known-good replacement files |

Harness tasks take their dependencies from `packages/bench/registry/<name>/<version>/`, package directories
(manifest, code, types, changelog). Corpus tasks take theirs from the corpus (below). `packages/bench/src/registry.ts`
serves both from `127.0.0.1` on a random port: fixtures packed into deterministic tarballs, corpus packages
exactly as published. It has no uplink: a request for anything it cannot serve is answered 404 and recorded as a
miss, and a task during which that happened is reported as an error, never as a pass or a fail. Each run writes a project `.npmrc` pointing at it (the same file autoremediator reads through
`platform/registry-config.ts`), installs, and makes a git baseline commit. `packages/bench/registry/<name>/meta.json`
may set publish times (`now-1h` for a "too new" release) and deprecation.

Everything else is hermetic too: user npm and git configuration are replaced by empty files, caches live
in the work directory, and every non-local request is routed to a dead proxy as a tripwire (it fails
loudly instead of reaching the internet; set `BENCH_TRIPWIRE_PROXY` to point it at a logging proxy).
The fixtures' `typecheck` script runs `node "$BENCH_TSC"`, the TypeScript in this repository, so a POSIX
shell is assumed.

### The tasks

Corpus tasks (the full list, with advisories and ranges, is in the [task catalogue](../../packages/bench/results/tasks.md)):

| Task | Correct outcome | What it tests |
| ---- | --------------- | ------------- |
| `lodash-template-injection` | fixed | lodash 4.17.20, a patch release fixes the advisory |
| `minimist-prototype-pollution` | fixed | minimist 1.2.5, a patch release |
| `moment-regex-dos` | fixed | moment 2.29.3, a patch release |
| `semver-regex-dos` | fixed | semver 7.3.7, the fix is a minor release |
| `strip-ansi-transitive-lockfile` | fixed | `ansi-regex` buried under `strip-ansi`, in a lockfile resolved as of September 2021; the existing range allows the fix |
| `json5-two-majors` | fixed | two copies of json5 in one tree, one on each major, resolved as of December 2022 |
| `request-tough-cookie-override` | fixed | `tough-cookie` pinned by `request` to another major than the fix; an override |
| `jsonwebtoken-key-type` | fixed (source edit) | the fix is a major release that refuses to sign with the project's RSA-PSS development key under RS256 |
| `jsonwebtoken-major-blocked` | refused (`major-bump-required`) | the same fix with a policy that forbids major bumps |
| `request-ssrf-no-fix` | unresolved (`no-safe-version`) | the advisory has no fixed version and the package is deprecated |

Harness tasks:

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

Their advisories are invented (`CVE-2099-*`) and their packages exist only in the benchmark.

## The corpus

Corpus data is in `packages/bench/corpus/`: the OSV records (`advisories/`), the packuments as the registry
published them, limited to the snapshot date (`packuments/`), and `lock.json`, which pins every served version to the
registry's own sha512. Tarballs are never committed. `pnpm bench:corpus restore` downloads them into the ignored
`.corpus-cache/` and refuses any that do not match the lock or fail the screen; the registry re-checks each one
against the lock before serving it. Curation is the only part of the benchmark that touches the network, and only to
read public data from the npm registry and OSV:

```bash
pnpm bench:corpus advisory <id> --package <name>   # store a published OSV record (malware and withdrawn ones are refused)
pnpm bench:corpus fetch <task>                     # resolve the task's tree (also as it would be after each fix) and store its packages
pnpm bench:corpus freeze <task>                    # write the task's intel.json from its advisory
pnpm bench:corpus verify [--require-cache]         # check everything committed against the lock
```

Each package keeps the versions its project resolves to, the fixed versions the advisory names with their
dependencies, and the 30 newest stable releases above them. The corpus is one registry snapshot, so a version
published after it is not part of the benchmark.

## What keeps a run from touching your machine

The fixture packages are installed and their code is run, so the harness does not rely on care:

- **Install scripts never run.** The baseline `npm install` and the oracle's `npm ci` pass
  `--ignore-scripts`, and the project's `.npmrc` sets `ignore-scripts=true`. The one exception is a
  trap task (one with a `canary`): its project keeps scripts enabled so the task can prove the tool
  refuses to run them. The canary is a harmless file written by a fixture this repository owns.
- **Library code runs in Node's permission model.** Every consumer project's `test` script is
  `SANDBOXED_TEST_SCRIPT` from `src/safety.ts`: reading the project is allowed, and writing, starting
  a process, a worker, an addon and the network are not. `src/tasks.test.ts` fails if a project's
  script differs, and `src/safety.test.ts` runs hostile tests against it. The `typecheck` script is
  not sandboxed: the compiler only reads declaration files and never runs dependency code, and
  TypeScript 7 launches a native binary the permission model would block.
- **A run only lives where it may be deleted.** The work directory must be a new directory inside the
  OS temp directory or the benchmark's own `.work` directory (symlinks resolved); `/`, the home
  directory and the parents themselves are refused.
- **No child process inherits a credential.** Every process the harness starts gets the environment
  with token, secret, password, API key and similar variables removed.
- **A package screen exists for published packages.** `screenTarball` in `src/screen.ts` reads a package
  tarball without installing it and rejects lifecycle scripts, native builds and binaries, links,
  paths that leave the package, dependencies fetched from outside the registry, and archives that
  expand beyond its caps. `src/screen.test.ts` also runs it over every fixture package and expects
  the install-script trap to be the only one flagged.

## How a task is scored

The oracle (`packages/bench/src/oracle.ts`) looks only at the project the run left behind, never at what the run
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
full run writes `packages/bench/results/<date>-agent-model.json` (it names the model) and adds a section to
`RESULTS.md`; a run restricted with `--task` is only printed unless you pass `--write`. The control
`ctl-false-claim` is scripted and is skipped. The wiring of this mode has been run against an unreachable
endpoint (it plans, applies, hands the item to the agent and reports the failed model call as a FAIL); it
has not been run against a real model.

## Adding a task

A corpus task:

1. Find the advisory and store it: `pnpm bench:corpus advisory <GHSA id> --package <name>`. Ask OSV which
   advisories apply to the exact `package@version` instead of trusting memory. Malware, withdrawn advisories and
   packages that fail the screen are refused.
2. Create `packages/bench/tasks/<id>/` with `task.json` (`"origin": "corpus"`, a `dimension`, the advisory id as the
   product will be asked about it, `package`, `osv`, and `expect`) and `project/`: a small consumer written from the
   package's documented usage, with exact pins, `node:test` tests whose golden values are recorded against the
   vulnerable version and use ordinary inputs only (never an exploit), a policy file, and a `test` script that is
   exactly `SANDBOXED_TEST_SCRIPT`. Use `baseline.before` when the lockfile should be as it was on a past date.
3. `pnpm bench:corpus freeze <id>` then `pnpm bench:corpus fetch <id>`, and commit the changes under `corpus/`.
4. A fix that edits source needs the known-good repair in `oracle/files/` (same paths as in the project, confined to
   `sourceEdits`). A task with no safe fix needs the `reason` the plan must report.
5. `pnpm --filter autoremediator-bench test`, then `pnpm bench --task <id>` in each mode, then a full `pnpm bench`
   to regenerate and commit the results. A failing task is a finding about the product, not a reason to change the
   task.

A harness task: add fixture packages under `packages/bench/registry/<name>/<version>/` (matching `package.json`,
`index.js`, `index.d.ts`, optionally `CHANGELOG.md`; `meta.json` sets publish times and deprecation), pin the
vulnerable version exactly in the consumer, and write `intel.json` by hand in the shorthand form (`packageName`,
`vulnerableRange`, optional `firstPatchedVersion`, `severity`). Steps 2 and 4 to 5 are the same.

## Limits

- The tasks are small projects written for the benchmark, over published packages and advisories. A pass says the
  pipeline handles that shape of problem, not that it handles your repository.
- The scripted modes are handed the answer. They can show the harness is sound, not that an agent is good.
- One package manager (npm), one ecosystem, one platform; results record the node version and platform.
- Durations are wall-clock on whatever machine ran them and vary from run to run.
