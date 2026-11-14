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

The app requests `contents`, `pull_requests` and `checks` write access and `metadata` read access.

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
