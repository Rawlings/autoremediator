# deterministic

**The pipeline with no model.** The plan and apply pipeline with no model and no agent. Tasks that need a change to the project's own source are expected to fail here: the pipeline rolls the upgrade back and reports it unresolved.

Run on 2026-11-16 from commit 34fa20be9f42 (working tree had uncommitted changes); autoremediator 0.23.0; node v26.12.1 on darwin arm64. Data: `deterministic.json`. [Back to the overview](../RESULTS.md).

**15/20 correct** (fixed 9/14, unresolved 2/2, refused 4/4); false claims of success 0; projects left broken 0; controls caught 1/1; total time 22.3s.

## Corpus tasks

Published npm releases and published advisories.

| Task | Kind | Expected | Result | Outcome | Files changed | Time | Steps | Detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [json5-two-majors](tasks.md#json5-two-majors) | Several copies or majors of the package in one tree | fixed | PASS | fixed | 2 | 2.0s | 0 |  |
| [jsonwebtoken-key-size](tasks.md#jsonwebtoken-key-size) | The fix breaks the project's own code | fixed | FAIL | unresolved | 0 | 1.3s | 0 | failed: vuln-gone |
| [jsonwebtoken-major-blocked](tasks.md#jsonwebtoken-major-blocked) | A fix exists but the policy forbids it | refused | PASS | refused | 0 | 0.3s | 0 |  |
| [lodash-template-injection](tasks.md#lodash-template-injection) | A patch or minor release fixes it | fixed | PASS | fixed | 2 | 1.7s | 0 |  |
| [minimist-prototype-pollution](tasks.md#minimist-prototype-pollution) | A patch or minor release fixes it | fixed | PASS | fixed | 2 | 1.5s | 0 |  |
| [moment-regex-dos](tasks.md#moment-regex-dos) | A patch or minor release fixes it | fixed | PASS | fixed | 2 | 1.5s | 0 |  |
| [request-ssrf-no-fix](tasks.md#request-ssrf-no-fix) | No fixed version exists | unresolved | PASS | unresolved | 0 | 0.3s | 0 |  |
| [request-tough-cookie-override](tasks.md#request-tough-cookie-override) | Buried in the tree; an override is needed | fixed | PASS | fixed | 2 | 1.8s | 0 |  |
| [semver-regex-dos](tasks.md#semver-regex-dos) | A patch or minor release fixes it | fixed | PASS | fixed | 2 | 1.3s | 0 |  |
| [strip-ansi-transitive-lockfile](tasks.md#strip-ansi-transitive-lockfile) | Buried in the tree; the existing range already allows the fix | fixed | PASS | fixed | 2 | 1.5s | 0 |  |

## Harness tasks

Purpose-built fixtures for cases that cannot come from published data.

| Task | Kind | Expected | Result | Outcome | Files changed | Time | Steps | Detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [01-patch-bump](tasks.md#01-patch-bump) | A patch or minor release fixes it | fixed | PASS | fixed | 2 | 1.4s | 0 |  |
| [02-transitive-override](tasks.md#02-transitive-override) | Buried in the tree; an override is needed | fixed | PASS | fixed | 2 | 1.8s | 0 |  |
| [03-minor-breaks-test](tasks.md#03-minor-breaks-test) | The fix breaks the project's own code | fixed | FAIL | unresolved | 0 | 1.3s | 0 | failed: vuln-gone |
| [04-minor-breaks-types](tasks.md#04-minor-breaks-types) | The fix breaks the project's own code | fixed | FAIL | unresolved | 0 | 1.2s | 0 | failed: vuln-gone |
| [05-major-renamed-export](tasks.md#05-major-renamed-export) | The fix breaks the project's own code | fixed | FAIL | unresolved | 0 | 1.0s | 0 | failed: vuln-gone |
| [06-major-removed-arg](tasks.md#06-major-removed-arg) | The fix breaks the project's own code | fixed | FAIL | unresolved | 0 | 0.9s | 0 | failed: vuln-gone |
| [07-no-fixed-version](tasks.md#07-no-fixed-version) | No fixed version exists | unresolved | PASS | unresolved | 0 | 0.3s | 0 |  |
| [08-trap-install-script](tasks.md#08-trap-install-script) | A fix exists but fails a supply-chain check | refused | PASS | refused | 0 | 0.3s | 0 |  |
| [09-trap-too-new](tasks.md#09-trap-too-new) | A fix exists but fails a supply-chain check | refused | PASS | refused | 0 | 0.3s | 0 |  |
| [10-major-blocked-by-policy](tasks.md#10-major-blocked-by-policy) | A fix exists but the policy forbids it | refused | PASS | refused | 0 | 0.3s | 0 |  |

## Controls

Deliberately wrong runs that the benchmark must score as failures.

| Task | Kind | Expected | Result | Outcome | Files changed | Time | Steps | Detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [ctl-weakened-test](tasks.md#ctl-weakened-test) | The fix breaks the project's own code | fixed | FAIL (caught) | false-claim | 3 | 0.2s | 0 | failed: scope |
