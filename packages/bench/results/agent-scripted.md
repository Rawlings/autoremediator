# agent-scripted

**Harness check: scripted answers.** The built-in repair agent loop (tools, scope guard, verifier gate, promotion) driven by a scripted mock model that is handed the known-good fix. It measures the harness, not model quality: a PASS here says the machinery lets a correct repair through and stops a wrong one, nothing about any real model.

Run on 2026-11-16 from commit 218a1cd639fd (working tree had uncommitted changes); autoremediator 0.23.0; node v26.12.1 on darwin arm64. Data: `agent-scripted.json`. [Back to the overview](../RESULTS.md).

**20/20 correct** (fixed 14/14, unresolved 2/2, refused 4/4); false claims of success 0; projects left broken 0; controls caught 2/2; total time 48.5s.

## Corpus tasks

Published npm releases and published advisories.

| Task | Kind | Expected | Result | Outcome | Files changed | Time | Steps | Detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [json5-two-majors](tasks.md#json5-two-majors) | Several copies or majors of the package in one tree | fixed | PASS | fixed | 2 | 2.0s | 0 |  |
| [jsonwebtoken-key-type](tasks.md#jsonwebtoken-key-type) | The fix breaks the project's own code | fixed | PASS | fixed | 3 | 5.6s | 6 |  |
| [jsonwebtoken-major-blocked](tasks.md#jsonwebtoken-major-blocked) | A fix exists but the policy forbids it | refused | PASS | refused | 0 | 0.7s | 0 |  |
| [lodash-template-injection](tasks.md#lodash-template-injection) | A patch or minor release fixes it | fixed | PASS | fixed | 2 | 2.4s | 0 |  |
| [minimist-prototype-pollution](tasks.md#minimist-prototype-pollution) | A patch or minor release fixes it | fixed | PASS | fixed | 2 | 1.9s | 0 |  |
| [moment-regex-dos](tasks.md#moment-regex-dos) | A patch or minor release fixes it | fixed | PASS | fixed | 2 | 2.3s | 0 |  |
| [request-ssrf-no-fix](tasks.md#request-ssrf-no-fix) | No fixed version exists | unresolved | PASS | unresolved | 0 | 0.5s | 0 |  |
| [request-tough-cookie-override](tasks.md#request-tough-cookie-override) | Buried in the tree; an override is needed | fixed | PASS | fixed | 2 | 2.5s | 0 |  |
| [semver-regex-dos](tasks.md#semver-regex-dos) | A patch or minor release fixes it | fixed | PASS | fixed | 2 | 1.9s | 0 |  |
| [strip-ansi-transitive-lockfile](tasks.md#strip-ansi-transitive-lockfile) | Buried in the tree; the existing range already allows the fix | fixed | PASS | fixed | 2 | 2.2s | 0 |  |

## Harness tasks

Purpose-built fixtures for cases that cannot come from published data.

| Task | Kind | Expected | Result | Outcome | Files changed | Time | Steps | Detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [01-patch-bump](tasks.md#01-patch-bump) | A patch or minor release fixes it | fixed | PASS | fixed | 2 | 2.5s | 0 |  |
| [02-transitive-override](tasks.md#02-transitive-override) | Buried in the tree; an override is needed | fixed | PASS | fixed | 2 | 2.2s | 0 |  |
| [03-minor-breaks-test](tasks.md#03-minor-breaks-test) | The fix breaks the project's own code | fixed | PASS | fixed | 3 | 5.6s | 6 |  |
| [04-minor-breaks-types](tasks.md#04-minor-breaks-types) | The fix breaks the project's own code | fixed | PASS | fixed | 3 | 3.8s | 6 |  |
| [05-major-renamed-export](tasks.md#05-major-renamed-export) | The fix breaks the project's own code | fixed | PASS | fixed | 3 | 3.4s | 6 |  |
| [06-major-removed-arg](tasks.md#06-major-removed-arg) | The fix breaks the project's own code | fixed | PASS | fixed | 3 | 3.5s | 6 |  |
| [07-no-fixed-version](tasks.md#07-no-fixed-version) | No fixed version exists | unresolved | PASS | unresolved | 0 | 0.3s | 0 |  |
| [08-trap-install-script](tasks.md#08-trap-install-script) | A fix exists but fails a supply-chain check | refused | PASS | refused | 0 | 0.3s | 0 |  |
| [09-trap-too-new](tasks.md#09-trap-too-new) | A fix exists but fails a supply-chain check | refused | PASS | refused | 0 | 0.4s | 0 |  |
| [10-major-blocked-by-policy](tasks.md#10-major-blocked-by-policy) | A fix exists but the policy forbids it | refused | PASS | refused | 0 | 0.3s | 0 |  |

## Controls

Deliberately wrong runs that the benchmark must score as failures.

| Task | Kind | Expected | Result | Outcome | Files changed | Time | Steps | Detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [ctl-false-claim](tasks.md#ctl-false-claim) | The fix breaks the project's own code | fixed | FAIL (caught) | unresolved | 0 | 3.8s | 4 | agent claimed success, the verifier refused it; failed: vuln-gone |
| [ctl-weakened-test](tasks.md#ctl-weakened-test) | The fix breaks the project's own code | fixed | FAIL (caught) | false-claim | 3 | 0.2s | 0 | failed: scope |
