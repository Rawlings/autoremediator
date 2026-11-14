# GitHub App

A webhook server that remediates repositories you install it on. It runs your package manager's
audit on a shallow clone, fixes what it finds, and can open a pull request.

## Behavior

| Event | Action |
| ----- | ------ |
| `check_suite` (requested, rerequested) | Remediate the repository |
| `push` to the default branch | Remediate the repository |
| `workflow_dispatch` | Remediate the repository |
| `check_run` completed with failure on an `autoremediator/*` branch | [Heal the pull request](#pull-request-healing), when enabled |
| `issue_comment` created, with a [command](#comment-commands) | Show a plan, or fix and open a pull request |
| `dependabot_alert` created or reopened | Remediate that advisory under the repository's settings |
| `code_scanning_alert` created or reopened, when the rule is a CVE or GHSA | Remediate that advisory under the repository's settings |

Webhooks are verified by signature, deduplicated by delivery id, queued, and retried with backoff.
Remediation is **off until you enable it**, and each repository starts in dry-run mode.

## Set up

1. Copy [`.env.example`](../../.env.example), set `AUTOREMEDIATOR_GITHUB_APP_BASE_URL` to the public
   URL of the server, and start it with `pnpm --filter @autoremediator/github-app start` or
   [`Dockerfile.github-app`](../../Dockerfile.github-app).
2. Open `/setup` on the server. It registers the app with GitHub and returns the app id, private
   key and webhook secret. Put them in the environment and restart.
3. Set `AUTOREMEDIATOR_GITHUB_APP_ENABLE_DEFAULT_REMEDIATION=true`.
4. Install the app on a repository and add `.github/autoremediator.yml` to it.
5. Once registered, set `AUTOREMEDIATOR_GITHUB_APP_ENABLE_SETUP_ROUTES=false`.

The app requests `contents`, `pull_requests`, `issues` and `checks` write access and `metadata`,
`vulnerability_alerts` and `security_events` read access, and subscribes to `check_run`,
`check_suite`, `issue_comment`, `dependabot_alert`, `code_scanning_alert`, `installation`,
`installation_repositories` and `push`. An app registered by an earlier version has none of the new
events: update its permissions and events on GitHub (or register it again) and accept the new
permissions on each installation. Without `check_run`, pull request healing never fires.

## Comment commands

On an issue or pull request, a comment line that starts with `/autoremediator`:

| Command | Does |
| ------- | ---- |
| `/autoremediator plan CVE-2021-23337` | Replies with what would change. Nothing is modified, whatever the repository's `dryRun` says |
| `/autoremediator fix CVE-2021-23337` | Fixes it and opens a pull request for review, even if the repository defaults to `dryRun` |
| `/autoremediator help` | Lists the commands |

Give one or more CVE or GHSA ids (up to ten). Only people with **write or admin access** to the
repository can use them; anyone else gets a one-line refusal and nothing runs. `fix` is an explicit
request from someone who could push anyway, so it goes ahead and opens a pull request even when
`dryRun` is on; it never merges. Quoted lines, fenced code and mid-line mentions are ignored, comments
written by bots (including the app's own replies) are never acted on, and nothing from a comment is
used except the command word and ids that match a strict pattern.

## Alerts

A new or reopened Dependabot alert that names a CVE or GHSA, or a code scanning alert whose rule is
one (dependency scanners such as Trivy and Grype report the CVE as the rule id), starts a run for
that advisory alone, subject to `minimumSeverity` and the repository's `dryRun` and `pullRequest`
settings. Other code scanning alerts are ignored.

## Repository configuration

`.github/autoremediator.yml` in each repository. It accepts the
[policy file](../reference/policy-file.md) keys listed below plus the app's own.

| Key | Default | Meaning |
| --- | ------- | ------- |
| `dryRun` | `true` | Plan only. Set `false` to let the app change code |
| `runTests` | `false` | Run tests after each change |
| `minimumSeverity` | `HIGH` | Ignore findings below this severity |
| `cwd` | repository root | Subdirectory to remediate. Must be relative and inside the checkout |
| `allowMajorBumps`, `denyPackages`, `allowPackages` | | As in the policy file |
| `constraints` | | `directDependenciesOnly`, `preferVersionBump`, `installMode`, `installPreferOffline`, `enforceFrozenLockfile`, `workspace` |
| `patchConfidenceThresholds` | | As in the policy file |
| `dispositionPolicy`, `containmentMode`, `escalationGraph` | | As in the policy file |
| `pullRequest` | off | `enabled`, `grouping`, `repository`, `baseBranch`, `branchPrefix`, `titlePrefix`, `bodyFooter`, `draft`, `pushRemote`, `tokenEnvVar` |
| `enablePrAutoHealing` | `false` | See below |
| `maxHealingAttempts` | `3` | Repair attempts per pull request |

## Pull request healing

When enabled, a failing check on a remediation branch is parsed (TypeScript diagnostics, linter
output, test assertions) and a repair is committed, up to `maxHealingAttempts` times. If the checks
still fail, the pull request gets the `autoremediator/needs-human-review` label and a summary
comment.

## Configuration

Credentials come from `/setup`. Everything else has a default; the full annotated list is in
[`.env.example`](../../.env.example). All variables start with `AUTOREMEDIATOR_GITHUB_APP_`.

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET` | | App credentials |
| `BASE_URL` | | Public URL; needed by `/setup` |
| `PORT` | `3001` | Listen port |
| `DATA_DIR` | unset | Persist deduplication and queue state across restarts |
| `GITHUB_URL`, `GITHUB_API_URL` | github.com | GitHub Enterprise Server URLs |
| `ENABLE_DEFAULT_REMEDIATION` | `false` | Run the built-in remediation handler |
| `TRIGGER_TIMEOUT_MS` | none | Cap on one remediation run |
| `ENABLE_SETUP_ROUTES`, `SETUP_SECRET` | `true`, unset | Registration routes, and a secret that gates them |
| `MAX_WEBHOOK_BODY_BYTES` | `262144` | Largest accepted webhook |
| `REQUIRE_JSON_CONTENT_TYPE` | `true` | Reject non-JSON webhooks |
| `REQUIRE_DELIVERY_ID` | `false` | Reject webhooks without `x-github-delivery` |
| `ALLOWED_EVENTS` | all | Comma-separated event allow-list |
| `ENABLE_JOB_QUEUE` | `true` | Queue work instead of running it in the request |
| `QUEUE_POLL_INTERVAL_MS`, `QUEUE_RETRY_DELAY_MS`, `QUEUE_MAX_ATTEMPTS` | `2000`, `15000`, `3` | Queue timing and retries |
| `WORKER_CONCURRENCY` | `1` | Jobs processed at once |
| `ENABLE_SCHEDULER`, `SCHEDULE_INTERVAL_MS` | `false`, `3600000` | Periodic scans without GitHub Actions |
| `ENABLE_STATUS_PUBLISHING`, `STATUS_CHECK_NAME` | `false`, `autoremediator/remediation` | Publish check runs for queued and finished jobs |
| `LOG_EVENT_TRACES` | `false` | One JSON log line per webhook |

`GET /health` reports runtime counters.
