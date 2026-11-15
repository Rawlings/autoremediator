---
"autoremediator": patch
---

Review fixes for dependency freshness, earned autonomy and the benchmark.

- **Freshness: unknown age.** With `maxAgeDays`, a package that is behind but whose installed version's
  publish time is unknown is no longer passed as within policy: it carries `unknownAge` (and
  `counts.unknownAge`) and is listed under `unplanned` with the reason; a climb does not stop on a
  landing version whose age is unknown.
- **Freshness: memory.** The planner skips a package pinned in remediation memory and never proposes a
  version a `rejected-upgrade` entry names; `--ignore-memory` / `ignoreMemory` lifts it (SDK and CLI only).
  `applyPlan` now re-checks pins at apply time and refuses a pinned package before changing anything.
- **Freshness: deprecated and 0.x.** A climb never lands on a deprecated release while another candidate
  exists, and holds the step when the only newer release is deprecated. Each `0.minor` is a breaking
  boundary: one per step, and crossing one counts as a major bump for `allowMajorBumps`.
- **Autonomy: window.** The window counts the last `window` runs, not events, so L4 is reachable when a
  run has several items.
- **Autonomy: track record.** Events carry a `prev` hash and the file a `head` hash; an edited, removed,
  reordered or hand-added event breaks the chain and the level falls to L0. A record written before
  hashes is accepted once and chained on its next append. The guide states that this is tamper-evidence,
  not authentication.
- **Benchmark.** The oracle requires `scripts`, `engines` and every non-target entry of `package.json` to
  be unchanged, and the results guard ties each row's score to its checks.
