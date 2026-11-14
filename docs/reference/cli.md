# CLI reference

`autoremediator [options] [target]` and `autoremediator <command> [options]`. The current flag list
for any command is always available with `--help`. This page groups them by purpose.

`target` is a CVE or GHSA id, or a scanner report path. Root options go before a subcommand;
options typed after a subcommand apply to it. Unknown options are an error.

## Commands

| Command | Purpose |
| ------- | ------- |
| `cve <id>` | Remediate one CVE or GHSA id (the same as passing it bare) |
| `scan` | Remediate from scanner output (`--input <path>`, or `--audit`) |
| `update-outdated` | Bump outdated dependencies (`--include-transitive`) |
| `portfolio` | Run across several projects (`--targets-file <path>`) |
| `diff` | Scan dependencies changed since a git ref (`--base <ref>`, default `HEAD`) |
| `triage [input]` | Choose what to fix interactively |
| `patches list \| inspect <path> \| validate <path> \| reconcile` | Manage generated patches. `reconcile --auto-apply` removes patches an upstream release has made obsolete |
| `reachability` | Is a package or symbol imported by project source (`--package`, `--symbol`) |
| `evaluate <package[@version]>` | Pre-install check (`--pkg-version`) |

`diff` also takes `--ci` and `--output-format text|json`. `patches list` and `inspect` take
`--patches-dir` and `--output-format`.

## Project

| Flag | Meaning |
| ---- | ------- |
| `--cwd <path>` | Project root. Defaults to the current directory |
| `--package-manager <name>` | `npm`, `pnpm`, `yarn`, `bun` or `deno`. Detected from the lockfile by default |
| `--workspace <name>` | Limit the run to one workspace package |
| `--policy <path>` | Policy file. Defaults to `.github/autoremediator.yml` |
| `--patches-dir <path>` | Where `.patch` files are written. Defaults to `./patches` |

## Inputs

| Flag | Meaning |
| ---- | ------- |
| `--input <path>` | Scanner report path |
| `--format <type>` | `auto`, `npm-audit`, `yarn-audit` or `sarif` |
| `--audit` | Run the package manager's audit instead of reading a file |
| `--offline` | Skip all advisory network calls |
| `--intelligence-snapshot <path>` | Advisory data to use with `--offline` |
| `--suppressions-file <path>` | Extra [VEX suppressions](policy-file.md#suppressions) |

## Behavior

| Flag | Meaning |
| ---- | ------- |
| `--dry-run` | Plan only; write nothing |
| `--preview` | Enforce non-mutating mode |
| `--simulation-mode` | Add planned mutations and rebuttal findings to a dry run |
| `--run-tests` | Run the project's tests after each change |
| `--typecheck` | Run the type checker after each change |
| `--direct-dependencies-only` | Skip transitive packages |
| `--prefer-version-bump` | Forbid overrides and patches |
| `--install-mode <mode>` | `standard`, `prefer-offline` or `deterministic` |
| `--install-prefer-offline <bool>` | Override the offline-cache preference |
| `--enforce-frozen-lockfile <bool>` | Freeze installs. Off by default, see [How it works](../how-it-works.md#verification) |
| `--skip-unreachable` | Skip CVEs whose package is never imported (heuristic) |
| `--proof-of-fix`, `--require-proof-of-fix`, `--reproduction-test <path>` | [Proof-of-fix verification](../how-it-works.md#verification); the last supplies the reproduction test script |
| `--breaking-change-refactor` | Experimental codemods for `rimraf` and `uuid` |

## Prioritization and outcomes

| Flag | Meaning |
| ---- | ------- |
| `--kev-mandatory` | Treat CISA KEV CVEs as mandatory regardless of severity |
| `--epss-threshold <0..1>` | Treat CVEs above this EPSS score as mandatory |
| `--sla-check` | Report CVEs past the SLA windows defined in the policy file |
| `--min-confidence-for-auto-apply <0..1>` | Below this, a result is held for approval |
| `--hold-for-transitive` | Hold transitive fixes for approval |
| `--escalate-on-kev` | Escalate KEV CVEs |
| `--containment-mode` | Roll back applied results that are held for approval |
| `--campaign-mode` | Rank portfolio targets by risk |

## Patch generation

| Flag | Meaning |
| ---- | ------- |
| `--model <provider:model-id>` | Model for the [patch fallback](../guides/patch-generation.md). Defaults to `AUTOREMEDIATOR_MODEL` |
| `--patch-confidence-low <0..1>`, `--patch-confidence-medium <0..1>`, `--patch-confidence-high <0..1>` | Acceptance threshold per risk level |

## Output and automation

| Flag | Meaning |
| ---- | ------- |
| `--output-format <text\|json\|sarif>` | Report format |
| `--summary-file <path>` | Write a machine-readable summary |
| `--ci` | Exit `1` if any remediation failed |
| `--no-evidence` | Do not write `.autoremediator/evidence/` |
| `--create-change-request` | Open a pull or merge request. See [Automation](../guides/automation.md#pull-requests) |
| `--change-request-provider`, `--change-request-grouping`, `--change-request-repository`, `--change-request-base-branch`, `--change-request-branch-prefix`, `--change-request-title-prefix` | Change request settings |
| `-i, --interactive` | Interactive triage |

## Provenance and replay

`--request-id`, `--session-id`, `--parent-run-id`, `--actor` and `--source` label the evidence file.
`--idempotency-key` with `--resume` returns a recorded result for a repeated run.

## Precedence

An explicit flag overrides the [policy file](policy-file.md), which overrides built-in defaults. A
flag you do not pass never overrides the policy file.
