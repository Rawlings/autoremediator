# Git hooks

Catch a risky dependency change before it leaves your machine. `autoremediator hook install` adds two
git hooks to the repository:

| Hook | When it runs | What it does |
| ---- | ------------ | ------------ |
| `pre-push` | Before `git push`, only if the pushed commits changed a manifest or lockfile | Runs `autoremediator diff --ci --base <upstream>` and **blocks the push** if the change makes the project's security posture worse (new vulnerabilities introduced) |
| `post-merge` | After `git merge` or `git pull`, only if the merge changed a manifest or lockfile | Prints a one-line advisory from `autoremediator diff --base ORIG_HEAD`. It never fails the merge |

```bash
autoremediator hook install          # shows what it would write, then asks
autoremediator hook install --yes    # writes without asking
autoremediator hook status           # installed, missing or modified; exits 1 on drift
autoremediator hook uninstall --yes  # removes only what install wrote
```

Both hooks do almost nothing on an ordinary push or merge: a cheap `git diff --name-only` checks for
`package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml` and `bun.lock`/`bun.lockb` first, and the CLI is not started when none changed.

## What a blocked push looks like

```text
Delta scan against base: 5f1c0e2...
Net Risk Verdict: DEGRADED
Newly Introduced CVEs: 2
Introduced Findings:
  - [GHSA-r5fr-rjxr-66jc] lodash@4.17.21 (UNKNOWN): lodash vulnerable to Code Injection via `_.template` imports key names
autoremediator: push blocked, the dependency changes make the project less safe.
autoremediator: review with 'autoremediator diff --base 5f1c0e2...', or set AUTOREMEDIATOR_SKIP_HOOKS=1 to push anyway.
```

The push is blocked **only** when the report says `Net Risk Verdict: DEGRADED`. Anything else (the
CLI missing, no network, a crash, a timeout) prints a note and lets the push through, so the hook can
not lock you out of your own repository.

The base is the first of: `PRE_COMMIT_FROM_REF` (set by the pre-commit framework), the branch's
upstream (`@{upstream}`), `origin/HEAD`, `origin/main`, `origin/master`. With none of those the check
is skipped with a note.

## Which hook manager

`hook install` writes what the tool already in the repository expects. It picks the first match:

| Manager | Found by | What is written |
| ------- | -------- | --------------- |
| husky | a `.husky/` folder, or `core.hooksPath` pointing into `.husky` | `.husky/pre-push` and `.husky/post-merge`; an existing script gets the block appended |
| lefthook | `lefthook.yml`, `.lefthook.yml` (or `.yaml`, or under `.config/`) | a command named `autoremediator` under `pre-push` and `post-merge` (a job, when that hook uses the `jobs:` syntax). Run `lefthook install` afterwards |
| pre-commit framework | `.pre-commit-config.yaml` | `repo: local` hooks `autoremediator-pre-push` and `autoremediator-post-merge` with `stages: [pre-push]` / `[post-merge]`. Run `pre-commit install --hook-type pre-push --hook-type post-merge` afterwards |
| plain git | none of the above | executable `pre-push` and `post-merge` files in the real hooks folder: `core.hooksPath` when set, else the repository's `hooks` folder (also correct inside a worktree, where `.git` is a file) |

`--manager husky|lefthook|pre-commit|git` overrides the choice. `--hooks pre-push` or
`--hooks pre-push,post-merge` selects the hooks (default: both).

## What install will not do

- Nothing outside the marked block, or outside the entry it owns, is touched. Shell hooks get a block
  between `# autoremediator:begin` and `# autoremediator:end`; YAML files get a named entry whose
  script carries the same markers.
- It reports a **conflict** and leaves the file alone when it cannot extend it safely: the file is not
  a shell script (a Node or Python hook), it ends with a top-level `exit` or `exec` (so appended code
  would never run), it is a symbolic link, the YAML is invalid, or an entry with the same name exists
  that Autoremediator did not write. Add the hook by hand in those cases.
- It never writes without `--yes`. Without a terminal and without `--yes` it prints a diff and exits
  `3` (waiting for approval), like `init`.
- Running it again changes nothing; a stale or edited block is refreshed in place.

`hook uninstall` removes exactly those blocks and entries. A hook file that held nothing else is
deleted; every other line of an existing hook comes back byte for byte.

## Exit codes

| Command | `0` | `1` | `3` |
| ------- | --- | --- | --- |
| `hook install`, `hook uninstall` | written, or already as asked | a conflict, or an error | changes are waiting for `--yes` |
| `hook status` | all selected hooks installed | drift (missing, modified, conflict) | not used |

`--output-format json` prints the full result (`manager`, per-hook `state`, `changes`, `conflicts`,
`nextSteps`).

## How the hook finds the CLI

The scripts are POSIX `sh` and also work under `sh -e` (husky 9). In order:

1. `node_modules/.bin/autoremediator` in the project: `npx --no-install autoremediator`
2. `autoremediator` on `PATH`
3. `npx -y autoremediator@^<major>.<minor>.0`, the release line that wrote the hook
4. none of those (no `npx`): skip with a note and exit `0`

Settings, as environment variables:

| Variable | Effect |
| -------- | ------ |
| `AUTOREMEDIATOR_SKIP_HOOKS=1` | Skip both hooks, for one command: `AUTOREMEDIATOR_SKIP_HOOKS=1 git push` |
| `AUTOREMEDIATOR_HOOK_TIMEOUT=<seconds>` | Time limit for the CLI (default `60` for `pre-push`, `30` for `post-merge`). When it passes, the push or merge goes on. Uses `timeout` or `gtimeout` when installed, else a built-in watchdog |

A fresh `npx -y` download can take a while on a slow network; install the CLI as a dev dependency
(`npm i -D autoremediator`) to make the hook fast and independent of the network. The delta scan reads
vulnerability data over the network; with no connection it cannot finish, and the hook lets the push
through.

## Monorepos

Hook files live at the repository root. When you run `hook install` from a subfolder, the project
folder is recorded in the script and the CLI runs there; the manifest check covers the whole
repository.

## From code

```ts
import { installHooks } from "autoremediator";

const plan = await installHooks({ cwd: ".", hooks: ["pre-push"] }); // reports, writes nothing
if (plan.drift && plan.conflicts.length === 0) await installHooks({ cwd: ".", hooks: ["pre-push"], yes: true });
await installHooks({ cwd: ".", uninstall: true, yes: true });
```

`installHooks` is available in the CLI and the SDK only. It is deliberately not an MCP tool or an HTTP
route, because it writes files that run on every push.

## Related

- [`diff`](../reference/cli.md): the delta scan the hooks run
- [Automation and CI](automation.md#exit-codes)
- [Setting up with `init`](../integrations/coding-agents.md)
