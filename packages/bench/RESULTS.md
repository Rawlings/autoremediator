# Benchmark results

How well does Autoremediator fix vulnerable dependencies? This page answers with measurements from
the open benchmark in `packages/bench`. Every figure is generated from the run files in
[`results/`](results/); a test fails if this page is edited by hand or falls behind them.

## At a glance

**With no model, Autoremediator fixed 7 of 8 vulnerable dependencies and correctly declined 2 of 2 that could not be fixed safely, without a false claim of success or a broken project.** The one it could not fix needs an edit to the project's own code, so it was rolled back untouched and reported.

10 tasks built from published npm packages and their published advisories, run with no model:

| Measure | Result |
| --- | --- |
| Correct outcomes | **9/10** |
| Vulnerable dependencies fixed and verified | **7/8** |
| Cases with no safe fix, reported honestly | **2/2** |
| Fixes claimed that were not real | **0** |
| Projects left broken | **0** |
| Upgrades that need your own code changed, rolled back and reported | **1** |
| Files changed by a fix (median) | **2** |
| Time per task (median) | **1.5s** |

A fix counts only if an independent oracle, which shares no code with the tool, installs the
result from its lockfile and the project's own type check and tests pass. A change that fails
verification is rolled back, never kept.

## By kind of problem

| Kind of problem | Tasks | From published data | Correct, no model | Otherwise |
| --- | --- | --- | --- | --- |
| A patch or minor release fixes it | 5 | 4 | 5/5 | all correct |
| Buried in the tree; the existing range already allows the fix | 1 | 1 | 1/1 | all correct |
| Buried in the tree; an override is needed | 2 | 1 | 2/2 | all correct |
| Several copies or majors of the package in one tree | 1 | 1 | 1/1 | all correct |
| The fix breaks the project's own code | 5 | 1 | 0/5 | 5 left untouched and reported |
| No fixed version exists | 2 | 1 | 2/2 | all correct |
| A fix exists but the policy forbids it | 2 | 1 | 2/2 | all correct |
| A fix exists but fails a supply-chain check | 2 | 0 | 2/2 | all correct |

## Where the pipeline stops without an agent

These tasks need an edit to the project's own source. With no model the pipeline rolls the upgrade
back, leaves the project as it found it and reports why; it never claims a fix it did not make.
With an agent attached it can attempt the repair, and the verifier decides whether the change is kept.

- [Minor bump that breaks a test](results/tasks.md#03-minor-breaks-test): rolled back, project left untouched
- [Minor bump that breaks the type check](results/tasks.md#04-minor-breaks-types): rolled back, project left untouched
- [Major bump with a renamed export](results/tasks.md#05-major-renamed-export): rolled back, project left untouched
- [Major bump that removes positional arguments](results/tasks.md#06-major-removed-arg): rolled back, project left untouched
- [jsonwebtoken major upgrade that rejects small keys](results/tasks.md#jsonwebtoken-key-size): rolled back, project left untouched

## Every mode

| Mode | What it measures | Correct | False claims | Left broken | Controls caught | Median time |
| --- | --- | --- | --- | --- | --- | --- |
| [deterministic](results/deterministic.md) | The pipeline with no model | 15/20 | 0 | 0 | 1/1 | 1.3s |
| [agent-scripted](results/agent-scripted.md) | Harness check: scripted answers | 20/20 † | 0 | 0 | 2/2 | 1.5s |
| [host-scripted](results/host-scripted.md) | Harness check: scripted host | 20/20 † | 0 | 0 | 2/2 | 1.9s |

† The run is handed the known-good answer. These modes check that the machinery lets a correct
repair through and stops a wrong one; they say nothing about how well a model repairs code.
Controls are deliberately wrong runs that the benchmark must score as failures.

## Model results

No run with a real model has been recorded yet, so nothing here says how well a model repairs a
breaking upgrade. The `agent-model` mode is how one is added: see [the guide](../../docs/contributing/benchmark.md).

## What these numbers do not show

- The tasks are small projects written for the benchmark. A pass shows the pipeline handles that
  shape of problem, not that it handles any particular repository.
- Corpus tasks use published releases and advisories, frozen with the registry as of 2026-11-16. Harness tasks
  cover cases that cannot come from published data, such as a release published an hour ago.
- The sample is small. Read the counts, not the percentages.

## More

- [Task catalogue](results/tasks.md): every task, its advisory, its range and its expected outcome.
- [How a task is scored, and how the benchmark keeps your machine safe](../../docs/contributing/benchmark.md).
- Reproduce: `pnpm build && pnpm bench:corpus restore && pnpm bench`. The restore step downloads the pinned
  package tarballs from the npm registry (about 30 MB) and checks each against `corpus/lock.json`; the
  benchmark then runs offline and needs no key.
