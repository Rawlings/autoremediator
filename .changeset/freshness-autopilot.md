---
"autoremediator": minor
---

Freshness autopilot: stay near the latest versions in small, verified steps, so most future security
fixes are a patch bump.

- **`autoremediator freshness`** reports how far behind the latest release each direct dependency is
  (major, minor and patch distance, stable releases behind, age of the installed version from the
  registry's publish times) and a 0-100 project freshness score. SDK `freshnessReport`; MCP tool and
  `POST /freshness` (read-only).
- **Policy key `freshness`**: `maxMajorsBehind`, `maxMinorsBehind`, `maxAgeDays` and `ignore`, validated
  like the other keys (unknown keys and a key that limits nothing are errors). Without it nothing is
  planned.
- **Step planner.** For a package past a limit the climb is one jump at a time: the newest release on
  the installed major, then one major per step, stopping at the first step inside the policy. Steps are
  ordered least breakable first with `assessUpgrade`, and a step rated High, a major bump without
  `allowMajorBumps`, or a package the policy excludes is held and reported, never applied
  (`--allow-high` takes High steps).
- **`freshness --apply [--max-steps n] [--package a,b] [--allow-high] [--run-tests] [--typecheck]`**
  (CLI and SDK `applyFreshness`) takes at most `--max-steps` steps (default 1). Each step is its own
  recorded run applied through `applyPlan`, so the verifier, the project's checks, agent repair (when a
  model is configured) and earned autonomy (refused below L2) behave as for a security fix. A step that
  does not hold is rolled back with `rollbackRun`, and that package is left alone for the call.
  `--create-change-request` opens one change request per step on its own branch.
- **`freshness --plan`** (SDK/MCP/HTTP `planFreshnessStep`, `POST /freshness/plan`) records the next step
  as a plan for a host to carry out with `applyPlan`, `verifyRun` and `rollbackRun`.
- New guide `docs/guides/freshness.md`.
