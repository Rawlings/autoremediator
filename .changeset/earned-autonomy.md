---
"autoremediator": minor
---

Earned autonomy: the policy sets a ceiling, the repository's own verified track record sets the level.

- New policy key `autonomy` (`ceiling: L0..L4`, plus `minVerifiedRuns`, `window`, `minSuccessRate`,
  `cooldownDays`, `requireTestCoverage`). L0 observe, L1 suggest (plan only), L2 open pull request,
  L3 auto-merge eligible, L4 autonomous with escalation. The level in force is the lower of the
  ceiling and the level earned; the ceiling can only be set in the policy file. Without the key,
  behaviour is unchanged.
- The track record is `.autoremediator/track-record.json`, a small committed file of append-only
  outcome summaries (run ids, coverage of tests and type check, one line of detail, no secrets),
  written under a lock and replaced atomically. It is updated from `applyPlan`, `runs verify`,
  `rollbackRun` and `finalizeAttempt`, best effort: a record that cannot be written never fails or
  undoes a run. Rollback never rewinds it.
- A rollback or a verifier failure demotes at once (L1, or L0 after two) for `cooldownDays`;
  promotion to L3 or L4 needs enough verified runs with passing tests (and type check for L4), a
  success rate above the bar and no recent incidents. The computation is a pure function of the
  record, so every promotion and demotion is explainable and reproducible.
- Below L2, `applyPlan`, `resumeRun`, `finalizeAttempt`, non-dry-run `remediate`/`remediateFromScan`/
  `remediatePortfolio`, `updateOutdated` and `reconcilePatchArtifacts` with `autoApply` refuse before
  changing anything and say why. At L0 `planRemediation` reports findings but records no plan.
  L3 and L4 only set `autoMergeEligible` and `escalate` on reports; nothing is merged.
- New read-only operation `getAutonomy` (SDK, MCP, `POST /autonomy`) and CLI
  `autoremediator autonomy status|explain`: level, ceiling, earned level, evidence, every promotion
  and demotion with its cause, and what the next promotion needs. Reports of `remediate`,
  `planRemediation` and `applyPlan` carry an `autonomy` summary when configured.
- `runs verify` no longer counts a later append to the track record as an out-of-scope change.
- New guide `docs/guides/earned-autonomy.md`.
