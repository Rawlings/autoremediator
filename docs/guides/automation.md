# Automation and CI

How to run Autoremediator unattended and consume its results.

## Exit codes

Without `--ci`, the command exits `0` unless it crashes. With `--ci` it exits `1` when any
remediation failed, so a pipeline can gate on it. `diff --ci` exits non-zero when the change
degrades the project's security.

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

`--create-change-request` commits the change on a new branch, pushes it and opens a pull request or
merge request. It is refused with `--dry-run` and `--preview`. Each provider reads its own token
variable; a GitHub token is never sent to another host.

| Provider | Opens | Token variable |
| -------- | ----- | -------------- |
| `github` (default) | Pull request | `GITHUB_TOKEN` or `GH_TOKEN` |
| `gitlab` | Merge request through the REST API, or `glab` when there is no token | `GITLAB_TOKEN` or `GITLAB_ACCESS_TOKEN` |
| `bitbucket` | Bitbucket Cloud pull request | `BITBUCKET_TOKEN` |
| `azure-devops` | Azure DevOps Services pull request | `AZURE_DEVOPS_EXT_PAT`, `AZURE_DEVOPS_TOKEN` or `SYSTEM_ACCESSTOKEN` |

See [Other CI systems](../integrations/other-ci.md) for pipeline templates.

| Flag | Meaning |
| ---- | ------- |
| `--change-request-provider` | `github`, `gitlab`, `bitbucket` or `azure-devops` |
| `--change-request-grouping` | `all`, `per-cve` or `per-package`: one request per group |
| `--change-request-repository` | `owner/name` (GitLab: `group/subgroup/name`, Azure DevOps: `org/project/repo`), when it cannot be inferred from the remote |
| `--change-request-base-branch` | Branch the request targets |
| `--change-request-branch-prefix` | Prefix for the new branch |
| `--change-request-title-prefix` | Prefix for the request title |

Only files the run modified and the patch files it generated are staged.

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
