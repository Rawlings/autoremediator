# Earned autonomy

How much Autoremediator may do in a repository should depend on what it has already done there. With
earned autonomy, your policy file sets a **ceiling**, the repository's own verified **track record**
sets what has been **earned**, and the level in force is the lower of the two. A rollback or a
verifier failure takes it down at once; it climbs back only with evidence.

It is opt-in. Without an `autonomy` key in the policy file nothing is refused, nothing is recorded and
reports carry no autonomy field.

```yaml
# .github/autoremediator.yml
autonomy:
  ceiling: L2 # required: the highest level this repository may ever act at
  minVerifiedRuns: 5 # verified runs needed for L3 (twice as many for L4). Default 5
  window: 20 # how many of the latest outcomes count as recent. Default 20
  minSuccessRate: 0.9 # share of recent runs that must have been verified. Default 0.9
  cooldownDays: 7 # how long a rollback or verifier failure caps the level. Default 7
  requireTestCoverage: true # L3 and L4 need runs whose tests (and type check) passed. Default true
```

Unknown keys are errors, and `window` must be at least twice `minVerifiedRuns` (or L4 could never be
reached). The ceiling lives **only** in the policy file: no CLI flag, MCP argument or HTTP field can
raise it, so an agent cannot give itself more room.

## The levels

| Level | Name                 | What it allows                                                                                  |
| ----- | -------------------- | ----------------------------------------------------------------------------------------------- |
| `L0`  | observe              | Reports findings. No plan is recorded and nothing is changed.                                   |
| `L1`  | suggest              | Plans only. Anything that would change the project is refused, with the reason.                 |
| `L2`  | open pull request    | Changes may be applied, for a person to review and merge. Where every repository starts.        |
| `L3`  | auto-merge eligible  | As L2, and a clean, fully verified run without a major bump is marked `autoMergeEligible`.       |
| `L4`  | autonomous           | As L3, also for major bumps, and a run that is not clean is marked `escalate`.                  |

**Autoremediator never merges anything.** L3 and L4 only set the `autoMergeEligible` and `escalate`
signals on reports (`autonomy` on the report of `remediate`, `planRemediation` and `applyPlan`), for a
merge rule or a person to act on. A run that earns a promotion is not itself marked eligible; the new
level applies from the next run.

## How the level is earned

The record starts empty and the repository starts at `L2`: changes arrive as pull requests that a
person reviews, so there is nothing yet to trust or distrust. Everything above `L2` has to be earned
and everything below it is a consequence of something that went wrong.

**Promotion** is computed from the last `window` outcomes:

| To   | Needs, all of                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `L3` | no rollback or verifier failure in the window; at least `minVerifiedRuns` verified runs; a success rate of at least `minSuccessRate`; with `requireTestCoverage`, at least `minVerifiedRuns` of those runs had the project's tests pass |
| `L4` | the same with twice `minVerifiedRuns` verified runs and tests-covered runs, and at least `minVerifiedRuns` runs whose type check passed       |

A run counts as verified when every change in it was accepted by the [verifier](plan-and-apply.md#verify)
and it was not later rolled back or failed `runs verify`. A change applied with `--no-verify` is
recorded but counts for nothing. "Tests passed" means `runTests` was requested (or `runs verify` ran
the `tests` check and it passed); a skipped check is not coverage.

**Demotion is immediate.** A rollback of a run that had changed the project, a change the verifier
rejected, or a failing `runs verify` on an applied run caps the level at `L1` for `cooldownDays`; two
different runs with such an incident inside the cooldown cap it at `L0`. The incident also stays in
the window, so `L3` and `L4` stay out of reach until enough newer outcomes push it out. Several
incidents on one run count once. After the cooldown the cap lifts and the level returns to what the
window supports.

The computation is a pure function of the record, the settings and the time: the same inputs always
give the same level.

## What the level gates

| Operation                                                                       | Below L2                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `applyPlan` / `runs apply`, `resumeRun` / `runs resume`                         | refused before anything changes                     |
| `finalizeAttempt`                                                               | refused                                             |
| `remediate` / `cve`, `remediateFromScan`, `remediatePortfolio`, jobs, unless `dryRun` or `preview` | refused (a scan reports one error per CVE) |
| `updateOutdated` unless `dryRun`; `reconcilePatchArtifacts` with `autoApply`    | refused                                             |
| `planRemediation` / `plan`                                                      | allowed at `L1`; at `L0` the findings are reported but no applicable plan is recorded |
| `rollbackRun`, `startAttempt`, `verifyRun`, dry runs, `getAutonomy`             | always allowed (they undo, read, or touch only an isolated checkout) |

A refusal names the level, the ceiling, what was earned and why, says nothing was changed, and points
at `autoremediator autonomy explain`.

If the track record exists but cannot be read (invalid JSON, a removed event, an unknown field), the
level is `L0` and changes are refused until a person fixes the file. A damaged record is never
silently replaced.

## Looking at it

```bash
autoremediator autonomy status     # level, ceiling, earned, evidence, what the next level needs
autoremediator autonomy explain    # also: why, the settings, and every promotion and demotion
```

`status` and `explain` accept `--cwd`, `--policy` and `--output-format json`. The same information is
the read-only operation `getAutonomy` (SDK: `getAutonomy({ cwd, policy })`, MCP tool `getAutonomy`,
`POST /autonomy`), which returns `level`, `ceiling`, `earned`, `allows`, `evidence`, `reasons`, `cap`,
`history` (each promotion and demotion with the event or cooldown behind it) and `nextPromotion` (the
requirements, each met or not).

## The track record

`.autoremediator/track-record.json` is a small file meant to be **committed**. It holds one summary
per outcome, in order, one per line so that a new event is one added line in a diff:

```json
{
  "schemaVersion": 1,
  "events": [
    {"seq":1,"at":"2026-11-14T21:23:42.974Z","type":"applied-verified","runId":"run_bjx62xf81s41zs8jd3kz","itemId":"item_4f3aeb39eee6","cveIds":["CVE-2021-23337"],"packages":["lodash"],"coverage":{"tests":true,"typecheck":false},"detail":"lodash 4.17.20 -> 4.18.1 (version-bump): applied"},
    {"seq":3,"at":"2026-11-14T21:25:22.397Z","type":"rollback","runId":"run_ejotlpb1vkinyvbkcjwa","cveIds":["CVE-2022-3517"],"packages":["minimatch"],"coverage":{"tests":false,"typecheck":false},"detail":"rolled back; 4 file(s) restored"}
  ]
}
```

Event types are `applied-verified`, `applied-unverified`, `apply-failed`, `verifier-failure`,
`rollback` and `verify-passed`. Each cites the run id, whose own ledger under `.autoremediator/runs/`
holds the detail. There is no command output and no secret in it; `detail` is one short line.

Events come from real outcomes: `applyPlan` (one per item), `runs verify`, `rollbackRun` and
`finalizeAttempt`. They are only ever appended. Writers are serialized with a lock directory and the
file is replaced atomically, so two terminals or CI jobs cannot lose or double-number an event. A
failure to write the record never fails or undoes the run: it is noted in the run's ledger
(`autonomy.record-failed`) and the outcome is simply not counted.

`init` ignores the whole `.autoremediator/` directory. To commit the record, ignore its contents and
re-include the one file:

```gitignore
.autoremediator/*
!.autoremediator/track-record.json
```

Rollback never rewinds the record, and `runs verify` does not count a later append to it as an
out-of-scope change. A change to the record that is not Autoremediator's own append shows up in a diff,
and in a pull request, like any other change; treat it as you would a change to the policy file.

### Limits

- The record is trusted as committed. It is not signed and has no hash chain, so anyone who can commit
  can edit it. The policy ceiling is the hard limit, and the policy file cannot be changed by a run.
- It only counts what went through the run operations. A direct `remediate` call applies changes (when
  the level allows) but adds nothing to the record; use `plan` then `runs apply` to build a record.
- The record grows by about 300 bytes per outcome and is never pruned.
- Turning the feature on starts from an empty record; earlier runs are not imported.
