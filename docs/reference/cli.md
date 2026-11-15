# CLI reference

`autoremediator [options] [target]` and `autoremediator <command> [options]`. The current flag list
for any command is always available with `--help`. This page groups them by purpose.

`target` is a CVE or GHSA id, or a scanner report path. Root options go before a subcommand;
options typed after a subcommand apply to it. Unknown options are an error.

## Commands

| Command | Purpose |
| ------- | ------- |
| `cve <id>` | Remediate one CVE or GHSA id (the same as passing it bare) |
| `plan <id>` | Preview a CVE fix and record it as a [plan](../guides/plan-and-apply.md); prints the run and plan ids |
| `runs list \| show <id> \| apply [id] \| verify <id> \| resume <id> \| rollback <id>` | Work with recorded runs: `list` takes `--status` and `--limit`, `apply` takes `--plan-id`, `--item`, `--no-verify`, `--repair`/`--no-repair`, `--model` and `--max-repair-rounds`, `verify` takes `--check <name...>` and `--offline`, `rollback` takes `--force`. All take `--cwd` and `--output-format text\|json` |
| `init` | Set up the project for Autoremediator and your coding agents ([details](../integrations/coding-agents.md)). Takes `--hosts <list>`, `--ci`, `--guard` (also install guard hooks for Claude Code, Cursor and Copilot, and a pnpmfile for pnpm projects), `--no-policy`, `--no-agents-md`, `--yes` and `--check`. Without `--yes` and without a terminal it prints a diff and exits `3` |
| `hook install \| uninstall \| status` | Add, remove or check the git hooks that run `diff` on push and merge ([details](../guides/git-hooks.md)). Takes `--hooks <list>` (`pre-push`, `post-merge`), `--manager husky\|lefthook\|pre-commit\|git`, `--allow-shared-hooks-path` (write into a hooks folder outside the repository), `--yes` (install, uninstall). Without `--yes` and without a terminal it prints a diff and exits `3`; `status` exits `1` on drift |
| `autonomy status \| explain` | Show the [autonomy level](../guides/earned-autonomy.md) in force, its ceiling, the level earned and what the next level needs; `explain` adds every promotion and demotion with its cause. `--cwd`, `--policy`, `--output-format` |
| `recipes list \| show <id> \| capture \| export` | Work with [recipes](../guides/recipes.md): `list` takes `--package`, `--from`, `--to`; `capture` takes `--run`, `--attempt`, `--from-range`, `--to-range`; `export` takes `--name`, `--out`, `--package`, `--package-version` |
| `trace run -- <command...>` | Run a command with the [runtime trace hook](../guides/runtime-reachability.md) and write `.autoremediator/trace.json`; `--packages a,b`, `--calls`, `--out`, `--timeout`. Exit code is the command's |
| `assess <package> --from <v> --to <v>` | How likely an [upgrade](../guides/upgrade-impact.md) is to break this project: High, Medium or Low with the affected call sites |
| `symbols <package> --from <v> --to <v>` | Heuristic candidate vulnerable symbols: exports a fix changed. `--advisory-text`, `--cwe a,b`, `--limit`, `--no-reachability` |
| `incident <id \| package@range>` | [Incident response](../guides/incident-response.md): exposure, lockfile history, rollback plan (`--plan`), rotation checklist (`--output-dir`). `--offline`, `--no-history`, `--max-commits`. Exit `0` clear, `3` in history only, `4` locked or installed now |
| `premortem` | Blast radius of a package being compromised across repos (`--targets-file` or `--root`; `--packages`, `--top`, `--rank-by`, `--playbooks`, `--output-dir`) |
| `bisect --good <ref> --command <cmd>` | Find which [lockfile update](../guides/bisect.md) breaks a command. `--bad`, `--timeout`, `--max-steps`, `--package-manager`, `--ignore-scripts`, `--apply`. Exit `0` found, `1` otherwise, `130` interrupted |
| `diet` | [Dependency diet](../guides/dependency-diet.md): unused, replaceable and duplicate dependencies and an attack-surface score. `--apply` removes only certainly-unused ones and verifies (`--run-tests`, `--no-typecheck`); `--verbose` |
| `evidence-pack --out <dir> \| verify <dir>` | Build or check a [CRA evidence pack](../guides/evidence-pack.md): SBOM, VEX, Article 14 drafts, signed run attestations. `--run`, `--policy`, `--awareness-at`, `--awareness CVE=iso`, `--corrective-measure-at`, `--signing-key`, `--product-name`, `--product-version`, `--manufacturer`; `verify` takes `--public-key` and exits `1` on a problem |
| `prove <advisory> --package <name>` | Generate and verify a [reproduction script](../guides/proof-of-fix-generation.md) (needs `--model`): `--vulnerable-version`, `--fixed-version`, `--advisory-text`, `--signing-key`, `--max-trials`, `--timeout-ms`, `--overwrite`. Exit `0` kept, `1` not proven |
| `radar` | [Security-relevant changes without an advisory](../guides/silent-fix-radar.md): `--include-transitive`, `--limit`, `--max-packages`, `--target latest\|minor\|patch`, `--github`, `--model [spec]`, `--no-assess`. Exit `3` when a likely one is found |
| `maintain`, `vex show` | [Maintainer VEX](../guides/maintainer-vex.md): `maintain` prepares a bump plan, changeset and the package's VEX (`--advisories`, `--assert-not-affected`, `--trace-file`, `--next-version`, `--yes`; exit `3` when not confirmed); `vex show` lists verdicts shipped by installed packages |
| `freshness` | [Dependency freshness](../guides/freshness.md): report, `--plan` one step, `--apply` (`--max-steps`, `--package`, `--allow-high`, `--run-tests`, `--typecheck`, `--model`, `--no-repair`, `--create-change-request`) |
| `memory list \| add \| accept \| remove \| prune` | [Remediation memory](../guides/memory.md). `--ignore-memory` on cve, scan, plan, update-outdated and portfolio bypasses it |
| `policy compile <rules...> \| explain` | [Policy in plain language](../guides/policy-in-plain-language.md): `compile` needs a model and writes only with `--yes` (`--allow-loosening`); exit `3` waiting for a yes, `1` rejected |
| `scan` | Remediate from scanner output (`--input <path>`, or `--audit`) |
| `update-outdated` | Bump outdated dependencies (`--include-transitive`) |
| `portfolio` | Run across several projects (`--targets-file <path>`) |
| `diff` | Scan dependencies changed since a git ref (`--base <ref>`, default `HEAD`) |
| `triage [input]` | Choose what to fix interactively |
| `patches list \| inspect <path> \| validate <path> \| reconcile` | Manage generated patches. `reconcile --auto-apply` removes patches an upstream release has made obsolete |
| `reachability` | Is a package or symbol imported by project source (`--package`, `--symbol`); `--trace-file <path>` adds [runtime evidence](../guides/runtime-reachability.md) |
| `guard [package...]` | Judge packages before installing them ([details](../guides/guard.md)); takes `--min-age-hours`, `--offline`, `--output-format`, and `--git-diff` (check dependencies added or changed in `package.json` since `--base <ref>`, default `HEAD`; a branch is compared at the merge base; `--include-transitive` adds packages only the lockfile gained, and the package list is then optional). Exits `0` clear, `3` check first, `4` blocked |
| `guard-hook` | Agent pre-command hook: reads the hook JSON on stdin, answers allow, ask or deny for package installs. `--host claude-code\|cursor\|copilot` (default `claude-code`) picks the output format |
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
| `--ci` | Exit non-zero if any remediation failed: `1` failed, `2` partly fixed, `3` waiting for approval, `4` blocked by policy (see [exit codes](../guides/automation.md#exit-codes)) |
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
