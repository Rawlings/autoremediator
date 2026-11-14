# Automation and CI

How to run Autoremediator unattended and consume its results.

## Exit codes

Without `--ci`, the command exits `0` unless it crashes. With `--ci` the exit code says what
happened, so a pipeline or an agent can decide what to do next:

| Code | Meaning | Usual next step |
| ---- | ------- | --------------- |
| `0` | Everything fixed, or nothing to do | Continue |
| `1` | Failed and nothing was fixed (or the command crashed) | Read the report |
| `2` | Partly fixed: some results applied, some failed | Merge what worked, look at the rest |
| `3` | The only unfinished results are held for a person (`policy-blocked`: containment or a required proof of fix held them) | Approve, then apply |
| `4` | The only unfinished results are forbidden by policy (`constraint-blocked`, `major-bump-required`) | Change the policy or fix it by hand |

A real failure outranks `3` and `4`: a run with an install failure and a held result exits `1` or
`2`, because approving the held one would not finish it. `init` also uses `3` for "changes are
waiting for a yes". `diff --ci` exits non-zero when the change degrades the project's security.
The codes are exported as `EXIT_CODES` from the SDK.

Under `--output-format json`, a fatal error is written to stderr as one JSON line
(`{"error":{"name":"...","message":"..."}}`), so a caller never has to scrape prose. Without it,
errors keep the `[autoremediator] message` form.

## Output

| Flag | Effect |
| ---- | ------ |
| `--output-format text` | Human-readable report (default) |
| `--output-format json` | The full report as JSON |
| `--output-format sarif` | SARIF 2.1.0, for code scanning |
| `--summary-file <path>` | Write a compact machine-readable summary |

Report shapes are described in the [SDK reference](../reference/sdk.md#reports). Pass the summary
file to your dashboards, or the SARIF output to GitHub code scanning with
[`autoremediator-sarif-upload.yml`](../../.github/workflow-templates/autoremediator-sarif-upload.yml).

## Evidence

Every run writes a JSON evidence file to `.autoremediator/evidence/`: a timestamped list of steps
(action, input, output, error) and a summary with success, failure and patch counts, strategy and
unresolved-reason breakdowns. Use `--actor`, `--source` and the correlation flags
(`--request-id`, `--session-id`, `--parent-run-id`) to attribute runs. `--no-evidence` disables it.

## Idempotent reruns

`--idempotency-key <key>` records the result under `.autoremediator/state/`. With `--resume`, a
second run with the same key returns the recorded result instead of repeating the work.

## Pull requests

`--create-change-request` commits the change on a new branch and opens a pull request (GitHub, using
`GITHUB_TOKEN` or `GH_TOKEN`) or a merge request (GitLab, using the `glab` CLI). It is refused with
`--dry-run` and `--preview`.

| Flag | Meaning |
| ---- | ------- |
| `--change-request-provider` | `github` or `gitlab` |
| `--change-request-grouping` | `all`, `per-cve` or `per-package`: one request per group |
| `--change-request-repository` | `owner/name`, when it cannot be inferred from the remote |
| `--change-request-base-branch` | Branch the request targets |
| `--change-request-branch-prefix` | Prefix for the new branch |
| `--change-request-title-prefix` | Prefix for the request title |

Only files the run modified and the patch files it generated are staged.

### Re-runs update the same pull request

The branch name depends only on what the request covers: `<prefix>/<cve>-<package>` for one CVE in
one package (`autoremediator/cve-2021-23337-lodash`), or the first CVE plus a short hash of the whole
set for a larger group. Running again for the same findings reuses that branch and, because a pull
request for it is already open, that pull request, instead of opening a duplicate. The result has
`updated: true`.

A re-run replaces only commits that autoremediator made earlier (its bot identity and a `Fixes-CVE`
trailer), and only if nobody has pushed to the branch since (`--force-with-lease`). If a person has
added a commit to the branch, nothing is overwritten: the result is `created: false` with an error
saying so, and the run's edits stay in your working tree.

Each commit message ends with trailers, so history says where a change came from:

```text
security remediation: CVE-2021-23337

Fixes-CVE: CVE-2021-23337
Autoremediator-Run: run_k3j2h1g0f9e8d7c6b5a4
Verified-By: autoremediator (install, test)
```

`Autoremediator-Run` appears when the report came from a recorded run. `Verified-By` appears only
when every applied result passed validation steps, and lists the steps they all passed.

## VEX and SBOM

Reports carry an `sbom`: each installed package with its CVEs and a `patched`, `unpatched`, `skipped`
or `suppressed` status. For a VEX document, convert any remediation or scan report to CycloneDX 1.5:

```ts
import { remediateFromScan, toCycloneDxVex } from "autoremediator";

const vex = toCycloneDxVex(await remediateFromScan("./npm-audit.json", { dryRun: true }));
```

The same conversion is the `toVex` MCP tool and `POST /vex`. Each CVE gets one state:

| State | When |
| ----- | ---- |
| `resolved` | Every affected package was fixed or suppressed, and at least one was fixed |
| `not_affected` | Every affected package carries an explicit [suppression](../reference/policy-file.md#suppressions) |
| `in_triage` | Anything else. The detail lists unresolved reasons |

Reachability never produces `not_affected`; it appears in the detail as a heuristic.

## Where to run it

- [GitHub Action](../integrations/github-action.md): a workflow step, with optional pull request.
- [GitHub App](../integrations/github-app.md): a server that reacts to repository events.
- A plain pipeline step: `npx autoremediator --audit --ci --run-tests`.
- Docker: the repository's [`Dockerfile`](../../Dockerfile) builds the CLI from source. It runs as a
  non-root user in `/workdir`, so mount the project there.

  ```bash
  docker build -t autoremediator .
  docker run --rm -v "$PWD:/workdir" autoremediator --audit --dry-run
  ```

Keep a [policy file](../reference/policy-file.md) in the repository so the same rules apply
everywhere.
