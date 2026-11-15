# Dependency freshness

Staying near the latest versions makes most future security fixes a patch bump instead of a
migration. `freshness` measures how far behind each direct dependency is, scores the project, and,
when your policy sets limits, climbs back inside them in the smallest verified steps: one package,
one jump at a time, each step its own [recorded run](plan-and-apply.md) that is rolled back if it
does not hold.

```bash
autoremediator freshness                  # report; changes nothing
autoremediator freshness --assess         # also rate the first step of each climb (upgrade impact)
autoremediator freshness --plan           # record the next step as a plan; apply it with `runs apply`
autoremediator freshness --apply          # take one step now (the default), verified
autoremediator freshness --ignore-memory  # plan as if the repository's memory were empty
autoremediator freshness --apply --max-steps 3 --package chalk,zod --run-tests --typecheck
autoremediator freshness --apply --create-change-request     # one change request per step
```

SDK: `freshnessReport(options)`, `planFreshnessStep(options)`, `applyFreshness(options)`.
MCP tools and HTTP routes: `freshnessReport` (`POST /freshness`, read-only) and `planFreshnessStep`
(`POST /freshness/plan`). Applying is deliberately not an MCP tool or HTTP route; see
[How a host applies a step](#how-a-host-applies-a-step).

## The policy

```yaml
# .github/autoremediator.yml
allowMajorBumps: true # steps that cross a major are held without it
freshness:
  maxMajorsBehind: 1 # at most one major behind the latest release
  maxMinorsBehind: 6 # at most six minors behind, counted on the latest major
  maxAgeDays: 540 # the installed version may be at most this old while a newer one exists
  ignore: [left-pad, "@types/*", "eslint-*"] # left alone, not counted in the score
```

Every limit is optional but at least one is required, `0` is a real limit (always on the latest
major), and unknown keys are errors like everywhere in the policy file. **Without a `freshness` key
the report still runs, and nothing is planned**: there is no limit to climb towards. `ignore` takes
an exact name, `@scope/*` or `prefix*`.

## What the report measures

For each direct dependency in `dependencies` and `devDependencies` that comes from a registry
(`workspace:`, `file:`, `link:` and git ranges are not covered):

| Field | Meaning |
| ----- | ------- |
| `majorsBehind` | Latest major minus installed major |
| `minorsBehind` | Latest minor minus installed minor, **only on the latest major** (3 minors behind means little across a major boundary) |
| `patchesBehind` | Likewise, only on the latest minor |
| `releasesBehind` | Stable releases newer than the installed version, up to the latest, from the registry's version list |
| `ageDays` | Days since the installed version was published, from the registry's `time` field |
| `unknownAge` | Only when the policy has `maxAgeDays`, the package is behind, and `ageDays` could not be found: the reason (see [Unknown age](#unknown-age)) |
| `penalty` | 0 to 100: 40 per major behind, 5 per minor behind (at most 30), 1 per patch behind (at most 10) |

The installed version and the latest release come from the package manager's own `outdated`
command, so private registries and `.npmrc` scopes work as they do for your installs. The
**freshness score** is 100 minus the mean penalty of the dependencies that count (ignored ones and
ones not installed do not). It is a transparent weighting to rank packages and give you one number to
watch, not a measurement of risk. A package that is not behind is never past a limit, however old its
version: there is nothing newer to move to. A dependency that is not installed is reported as such
and left out; install first.

`maxPatchesBehind` does not exist on purpose: a patch distance is not worth a pull request. Patches
ride along on the catch-up step.

## The climb

For a package past a limit, the planner lays out the whole climb and stops at the first step that
leaves it inside the policy, so a package allowed to trail by one major is not dragged onto the
newest one.

1. **Catch up on the installed major.** The newest stable release of the major you are on. This is
   the migration path upgrade guides recommend, and the lowest-risk move there is.
2. **One major per step.** The newest stable release of the next major that has one. Majors the
   registry has no release for are skipped; prereleases are never a target.

Two rules refine that:

- **Below 1.0.0 every `0.minor` is a breaking boundary.** A 0.x minor may break, so `0.2.0 -> 0.9.0`
  is not one "catch-up" step: it is `0.2.x`, then `0.3.x`, and so on, one `0.minor` per step, and a step
  that crosses one counts as a major bump for `allowMajorBumps` (held without it).
- **A climb never lands on a deprecated release while another candidate exists.** Within a major the
  newest release that is not deprecated is chosen; a major whose newer releases are all deprecated is
  skipped. If every candidate is deprecated, the step is **held** ("only newer release is deprecated"),
  never taken. A version that remembered memory has rejected is never a candidate either (see
  [Memory](#memory)).

Example: `chalk` at 3.0.0, latest 5.3.0, `maxMajorsBehind: 0`: `3.0.0 -> 3.0.1 -> 4.1.2 -> 5.3.0`,
taken one step per call. With `maxMajorsBehind: 1` the climb ends at `4.1.2`.

Only the **first** step of each climb is ever taken in one go, because the next one is planned
against the project the first one leaves.

### Ordering and holds

With `--assess` (always on for `--plan` and `--apply` unless `--no-assess`) the first step of each
climb is rated by [`assessUpgrade`](upgrade-impact.md), up to four packages at a time. Climbs are
taken **from least to most breakable**: Low, Medium, then Unknown (the rating could not be made,
for example a tarball could not be read; the reason is in the report), then High. Ties go to the
smaller step (patch, minor, major), then to the climb nearer done, then to the name.

A step is **held**, reported and never applied, when:

- it is rated High and `--allow-high` is not set (High means project code reaches a breaking change,
  or the project's own manifest cannot meet the new requirement);
- it crosses a major (or a 0.x minor) and the policy has `allowMajorBumps: false`;
- the only newer release is deprecated;
- the policy's `allowPackages` or `denyPackages` excludes the package.

A held climb stays in the report with its reason. The other packages go on.

### Unknown age

`maxAgeDays` needs the publish time of the installed version. When the policy sets it and the package
is behind but that time is unknown (the registry could not be read, the package is not on it, or it
lists no time for that version), the package is **not** reported as within policy and is **not** climbed
blindly: it carries `unknownAge` with the reason, is counted in `counts.unknownAge`, and is listed under
`unplanned`, so a scheduled run shows it instead of passing it. If the same package is past another limit
it is still climbed for that limit. While climbing, a landing version whose own publish time is unknown
is not assumed to satisfy `maxAgeDays`: the climb goes on.

### Memory

The planner reads [remediation memory](memory.md) the way `remediate` does. A **pinned package** is left
alone: it is listed under `unplanned` with the pin's reason and is never planned or applied. A version
a **rejected upgrade** entry names is never proposed: the climb lands on the next best release, and a
package whose every newer release was rejected is listed under `unplanned` with the entries. Only
`active`, unexpired entries count. `--ignore-memory` (SDK: `ignoreMemory`) plans as if memory were empty,
and is recorded in the plan so applying it does not consult memory either. It is not accepted over MCP or
HTTP. `applyPlan` re-checks pins when a plan is applied (see [memory](memory.md#what-reads-it)).

## Applying: one verified step per run

`--apply` takes at most `--max-steps` steps (default **1**, so a scheduled job makes one small,
reviewable change per run). For each step:

1. **Plan.** The step is recorded as an ordinary run with a one-item plan (`version-bump`),
   named `FRESHNESS-<target version>`, so `runs show`, `runs verify` and `runs rollback` work on it
   like on any other run.
2. **Apply.** Through the same `applyPlan` as a security fix: a snapshot first, the package manager's
   install, your tests (`--run-tests`) and type check (`--typecheck`), then the
   [verifier](plan-and-apply.md#verify) (only dependency files changed, policy and supply-chain
   rules hold). The step counts as done only if all of that passes.
3. **Repair, if available.** When a model is configured (`--model` or `AUTOREMEDIATOR_MODEL`), a step
   that breaks your checks is handed to the [repair agent](plan-and-apply.md#repair-with-an-agent)
   exactly as `runs apply` does, and recipes are tried first. `--no-repair` never spends tokens.
   Nothing here re-implements repair.
4. **On failure, roll back.** The step is taken back out (`rollbackRun`, so the run is closed as
   `rolled-back` and `node_modules` matches the lockfile again), that package is left alone for the
   rest of this call, and the report says why. The other packages go on. A call stops trying after
   three failed attempts, so a project where everything fails does not spend the night finding out.

Only applied steps count towards `--max-steps`; a failed attempt does not. Because each step is its own
run, any single step can be undone later with `autoremediator runs rollback <runId>`.

The exit code is `0` when steps were applied or there was nothing to do, and `1` when any step failed
(even if another landed), so a scheduler notices.

### Change requests

`--create-change-request` (with `--change-request-provider`, `--change-request-repository`,
`--change-request-base-branch`, `--change-request-branch-prefix`) opens one change request per
applied step through the same code as `remediate`. The branch is named for the package and the target
version (`autoremediator/freshness-4.1.2-chalk`), so a re-run for the same step updates it instead of
opening a duplicate. The title is `dependency freshness: chalk 3.0.1 -> 4.1.2`, and the commit does
not carry a `Fixes-CVE` trailer. After each change request the working tree returns to the base
branch and `node_modules` is reinstalled from it, and **the next step of the same package waits**: it
would build on a change nobody has merged. Other packages continue within the same call.

### Earned autonomy

If the policy has an [`autonomy`](earned-autonomy.md) key, `--apply` is refused below L2 before
anything is recorded or changed, with the same message and `AutonomyRefusedError` as `runs apply`.
`--plan` records nothing at L0 and a plan at L1 and above. Each applied or failed step is recorded in
the track record by the run machinery exactly like any other run, so a step that fails verification
counts against the level.

## How a host applies a step

An agent host (Claude Code, Cursor, a script) uses the tools that already exist:

1. `freshnessReport` to see the state and the climbs.
2. `planFreshnessStep` records the next step as a plan (one at a time: applying it changes the
   manifests any other plan was made against) and returns `runId` and `planId`.
3. `applyPlan` (the review of the plan is the approval), then `verifyRun`, and `rollbackRun` to undo.
4. `planFreshnessStep` again for the next step.

`autoremediator freshness --apply` is the same loop in one process, for a scheduler, and is
CLI and SDK only for the same reason `diet --apply` is: it chains writes and git operations.

## A weekly job

```yaml
# .github/workflows/freshness.yml
on:
  schedule: [{ cron: "0 6 * * 1" }]
jobs:
  freshness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx autoremediator freshness --apply --run-tests --typecheck --create-change-request
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## What it cannot see

- **Behaviour.** The impact rating is a static heuristic; the verifier and your own tests are what
  hold. Without `--run-tests` a step is verified only for scope, policy, supply-chain and install.
- **Transitive dependencies** are not climbed; they are covered by `remediate` and `update-outdated`.
- **Workspaces.** Only the root `package.json` is read.
- **Ranges.** A step writes the target version with the prefix already in `package.json` (`^`, `~`
  or none). A step does not widen a range to cover a version the package manager would not take.
- **Release timing.** `maxAgeDays` uses the registry's publish time of the installed version. A
  registry that does not serve `time` gives no ages: every package that is behind is then reported with
  `unknownAge` and listed under `unplanned` (the limit cannot be checked), not treated as within policy.
- **Cost.** `--assess` downloads two tarballs per package with a step due, from the registry your
  `.npmrc` names.
