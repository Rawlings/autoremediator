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
| `check_run` completed with failure on a `dependabot/*` or `renovate/*` branch | Run the [bot PR doctor](#bot-pr-doctor), when enabled |
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
| `/autoremediator retry CVE-2021-23337` | Runs it again the way it was last run in this repository (`plan` or `fix`) |
| `/autoremediator rollback` | Replies with the command that undoes the run this pull request records. Changes nothing |
| `/autoremediator help` | Lists the commands |

Give one or more CVE or GHSA ids (up to ten). Only people with **write or admin access** to the
repository can use them; anyone else gets a one-line refusal and nothing runs. `fix` is an explicit
request from someone who could push anyway, so it goes ahead and opens a pull request even when
`dryRun` is on; it never merges. Quoted lines, fenced code and mid-line mentions are ignored, comments
written by bots (including the app's own replies) are never acted on, and nothing from a comment is
used except the command word and ids that match a strict pattern.

`retry` repeats the last `plan` or `fix` for each id given, so it needs an earlier one: the app keeps
that history per repository and advisory in its state store (set `DATA_DIR` to keep it across
restarts). An id with no history, or ids last run in different modes, get an explanation and nothing
runs. A request is recorded before it runs, so a run that failed can be retried.

`rollback` never rolls anything back. It reads the `Autoremediator-Run:` trailers in the pull request
description (or, if there are none, in the pull request's commit messages), and replies with
`autoremediator runs rollback <runId>` for each run id that matches the run id format exactly. A run
is recorded in the `.autoremediator/runs` folder of the checkout that made it, so the command works
where that folder exists. A pull request the app opened from its own temporary checkout has no such
record; revert its commits instead.

There is no `approve` command. Nothing the app could do on a comment would be a safe substitute for a
reviewer's approval (approving a pull request or enabling auto-merge would bypass the repository's
review rules), so the word is unrecognised and answered with the help text.

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
| `botPrDoctor` | off | `enabled` (default `false`) and `maxAttempts` (1 to 5, default `2`). See [Bot PR doctor](#bot-pr-doctor). `botPrDoctor: true` turns it on with the default cap |

## Pull request healing

When enabled, a failing check on a remediation branch is parsed (TypeScript diagnostics, linter
output, test assertions) and a repair is committed, up to `maxHealingAttempts` times. If the checks
still fail, the pull request gets the `autoremediator/needs-human-review` label and a summary
comment.

## Bot PR doctor

When CI fails on a Dependabot or Renovate pull request, the doctor reads what failed and either pushes
a small repair commit to the bot's branch or leaves one comment with the diagnosis. It is **off
unless a repository turns it on**:

```yaml
# .github/autoremediator.yml
botPrDoctor:
  enabled: true
  maxAttempts: 2
```

A failing check run is looked at when its pull request's branch starts with `dependabot/` or
`renovate/` (a branch name alone is not enough to be repaired: see the checks below). A bot pull
request on a custom branch prefix is not picked up, because the webhook does not carry the author.
The failure is read from the check's output and annotations, using the same parser as pull request
healing (TypeScript errors, linter output, test failures).

What it will and will not do:

- **Fast-forward commits only.** Repairs are commits on top of the branch tip, written through the
  GitHub contents API against the file version it read. It never force-pushes or rewrites history, and
  if the branch or file changed in the meantime GitHub refuses the write.
- **Source files only.** It never writes lockfiles, `package.json`, anything under `.github/`
  (workflows, `autoremediator.yml`), autoremediator policy files, or paths that leave the repository.
  File paths come from CI logs, so each is checked before it is read. At most five files per attempt.
- **Open, same-repository pull requests only.** Pull requests from forks are ignored, and so is a
  failure from a commit the branch has already moved past.
- **Capped.** Attempts per pull request are counted in the app state store, once per head commit (so
  several failing checks on one commit, or a redelivered webhook, cost one attempt), and stop at
  `maxAttempts`. The app then says so in one comment and goes quiet. The count survives restarts when
  `DATA_DIR` is set; without it the state store is in memory. With no state store at all the doctor
  does nothing.
- **Output is data.** Text from checks is cleaned (control and bidirectional characters, backticks)
  and cut to length, and only ever appears inside one code block in the comment. It is never run,
  never used as a command and never decides which files may be changed.
- **No loops.** The app's own check runs (names starting `autoremediator`, or created by this app) are
  never diagnosed, and the attempt cap bounds everything else.

If the failure cannot be repaired safely (the output names no source file, or the errors are not ones
the repair strategy handles) the pull request gets one comment with the diagnosis and nothing is
pushed. Bot branches always go to the doctor, never to [pull request healing](#pull-request-healing),
even when a dependency name puts "autoremediator" in the branch name.

Pushing a commit to a Dependabot or Renovate branch makes the bot treat the branch as edited by
someone else: Dependabot stops rebasing it, and Renovate stops updating it until the edit is
reverted or the pull request is closed. That is the cost of a repair commit; leave the doctor off if
you would rather the bots keep control of their branches.

### Repair strategies

A repair is produced by a `RepairStrategy` (`{ name, repair({ filePath, content, findings }) }`),
which only returns new file content. The doctor and pull request healing use the pattern-based
strategy, which fixes default-import mismatches, compiler "did you mean" suggestions and unused
imports, and does nothing for other errors. A different strategy can be passed to
`createDefaultRemediationHandler({ repairStrategy })`; the paths, attempt cap and commit rules above
apply to whatever it returns. There is no built-in agent-backed strategy yet.

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
