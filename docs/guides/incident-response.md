# When a package is compromised

A maintainer account is taken over, a malicious version is published, an advisory appears. Two
commands help, one for the day it happens and one for the days before. Both run locally, read your
checkouts, and change nothing unless you ask.

```bash
autoremediator incident MAL-2026-1234              # an advisory id (MAL-, GHSA-, CVE-)
autoremediator incident 'left-pad@>=1.3.0 <1.3.2'  # or a package and the bad versions: no lookup needed
autoremediator premortem --root ~/code --top 10 --output-dir docs/security
```

## `incident`

```bash
autoremediator incident <MAL-id | GHSA-id | package@range> [--plan] [--output-dir <dir>] [--offline] [--no-history]
```

It answers four questions.

**1. Is it here?** Every lockfile at the project root is read (`package-lock.json`,
`npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, text `bun.lock`) as a dependency graph. For
each affected locked version the report gives direct or transitive, production or development, the
shortest parent chain from the project (or workspace) down to the package, the packages that depend
on it directly, and whether installing it runs scripts (from the lockfile where the format records
it, else from the installed copy's `package.json`, else "unknown"). If `node_modules` exists, the
package manager's own inventory is cross-checked. The binary `bun.lockb` is not readable; the report
says so.

**2. When did it enter, and what could have installed it?** The git history of every lockfile (all
branches) is read straight out of git and parsed with the same lockfile parsers, so nothing is
checked out and nothing is installed. For each affected version: the commits where it entered and
left (sha and date), whether HEAD still has it, the branches and tags whose tip has it in the
lockfile, the ones whose history passes through the entering commit but have moved on, and the
version the lockfile had just before. It also lists when `package.json`'s declared range changed.
History is bounded (`--max-commits`, default 500 lockfile commits, newest first) and says when it is
truncated or the clone is shallow. Git records commits, not deploys: the report lists commits and
refs and tells you to check your CI and deployment logs. It never guesses a deploy.

**3. Roll back to the last safe version.** For each affected locked copy, the target is the newest
version outside the affected range that is older than the installed one. With the registry reachable
that is the newest published one (deprecated versions are skipped); with `--offline`, or when the
registry cannot be read, it is the newest one the project's own lockfile history shows it has run
("last used before"). A newer unaffected release, if any, is reported but never chosen: moving
forward is a separate decision. Direct dependencies get an exact pin in `package.json`; transitive
ones get the package manager's override field. If no older safe version is known (for instance every
version is affected) the report says to remove or replace the dependency.

With `--plan` the proposal is recorded through the normal [run machinery](plan-and-apply.md): the
plan item is marked `rollback`, held for approval, and carries the bad range so the verifier's
`vuln-gone` check proves afterwards that no installed copy is still in it. A rollback is pinned
exactly (a caret range would still accept the bad version the lockfile already holds). Nothing is
applied by `incident`:

```bash
autoremediator runs show <runId>
autoremediator runs apply <runId>       # snapshot, apply, verify; undo with: runs rollback <runId>
```

**4. What should be rotated?** A checklist of the **names** of secrets that were in reach of an
install while the bad version was locked: `${{ secrets.X }}` and sensitive-looking `env:` names in
GitHub Actions jobs that install (workflow, job and step scope; secrets of jobs that never install
are left out), credential-looking variables in GitLab, CircleCI, Azure, Bitbucket, Travis and
Jenkins files, `ARG`/`ENV` names and secret mounts in Dockerfiles, names in `.env.example` style
templates, `${VAR}` references in `.npmrc` (and whether a credential is written into it), and the
project's own install-time scripts. Generic steps follow: npm tokens, CI secrets, cloud keys, SSH and
git tokens, developer machines, rebuilding clean. It is a **checklist to review, not a finding that
anything was compromised**.

Secret values are never read: templates and `.npmrc` are read line by line and only the name part is
kept, a literal value in a workflow or Dockerfile is dropped, and real `.env` files are not opened at
all. Names and paths that come from lockfiles, refs and CI files are escaped before they reach the
markdown, so they cannot inject headings, table cells or code fences.

### Output

`--output-dir <dir>` writes `incident-report.md` and `incident-report.json` there (the directory is
created). Without it the markdown prints (`--output-format json` prints the JSON). Nothing else is
written, except the run record when `--plan` is set.

Exit codes: `0` not locked and never found in history, `3` not locked now but it was in history,
`4` an affected version is locked or installed now.

`--offline` needs no network for `package@range`. For an id it needs `--intelligence-snapshot`
([offline mode](offline.md)); otherwise ids are looked up in OSV and the GitHub advisory database.

## `premortem`

"What if X is compromised tomorrow?" across many repositories, before it happens.

```bash
autoremediator premortem --targets-file targets.json --packages lodash,axios
autoremediator premortem --root ~/code --top 10 --rank-by privileged --output-dir docs/security
```

Repositories come from `--targets-file` (the same JSON array as [`portfolio`](automation.md); only
`cwd` and `label` are read) or `--root`, which finds directories with a `.git` next to a
`package.json` (three levels deep, no symlinks, no `node_modules`). Packages come from `--packages`,
or the `--top` N (default 10) most depended-upon across the repositories (`--rank-by depended-upon`,
by repositories then distinct dependents) or most privileged (`--rank-by privileged`, packages that
run install scripts first). For each package: how many repositories lock it, how many packages depend
on it, which versions, direct or transitive, production or development, whether it runs install
scripts, and in which repositories CI installs run with secrets in reach. It reads checkouts only and
uses no network.

With `--output-dir`, a **playbook** per repository (default) or per package (`--playbooks package`)
is written to `playbooks/`, with `premortem.md` as an index and `premortem.json`. Each playbook lists
what matters and the exact `autoremediator incident ...` commands to run on the day, with the path
shell-quoted. They are meant to be committed (point `--output-dir` at a directory you track, such as
`docs/security`); regenerate them when dependencies change. They contain repository paths as given,
so a playbook committed to a shared repository shows your local paths.

## From code and agents

SDK: `incident(target, options)`, `incidentExitCode(report)`, `renderIncidentMarkdown(report)`,
`premortem(options)`. MCP tools and HTTP routes (`POST /incident`, `POST /premortem`) are generated
from the same definitions. They are analysis: the output directory and `plan` are the only things
that write, and every path (`cwd`, `outputDir`, `root`, `targets[].cwd`, `policy`,
`intelligenceSnapshotPath`) is confined to the allowed roots.
