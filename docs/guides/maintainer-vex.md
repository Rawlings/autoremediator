# VEX in the package, and the maintainer autopilot

Most advisories in your tree are about a dependency of a dependency, and most of those do not matter:
the library that depends on the vulnerable package never calls the vulnerable code. Today only the
library's maintainer knows that, and the only way to tell you is a GitHub issue or a changelog. This
page describes a small convention that lets a package ship that knowledge in its own tarball, and the
two halves of Autoremediator that use it:

- **Consumer**: when a remediation or scan finds a vulnerable dependency, the `not_affected` verdicts
  that installed packages ship are read from `node_modules` and shown as evidence. A policy switch
  lets you act on them.
- **Producer** (`autoremediator maintain`): for package authors. When a dependency of the package you
  develop gets an advisory, decide whether your package is affected, and prepare (never publish, never
  push) a bump plan, a changeset and the OpenVEX statement to ship.

Everything runs on your machine. Nothing is sent anywhere and no server is involved: the verdicts
travel with the package, so they are available offline.

## For consumers

```bash
autoremediator vex show                      # what installed packages ship, validated
autoremediator vex show --advisory CVE-2024-1234
autoremediator CVE-2024-1234 --dry-run       # results carry maintainerVex evidence
```

For each vulnerable installed package, the results of `remediate`, `planRemediation` and scans gain
`maintainerVex`: who vouches (`demo-lib@1.0.1`), the document and its author, the OpenVEX
`justification`, and the maintainer's own words. The CycloneDX output of `toVex` lists the same under a
vulnerability `properties` entry named `autoremediator:maintainer-vex`.

**By default this is evidence only.** Remediation goes ahead exactly as before. To act on it, opt in in
the [policy file](../reference/policy-file.md):

```yaml
trustMaintainerVex: true
```

Then a vulnerable copy covered by an accepted `not_affected` statement is not remediated. The result
behaves like a policy suppression: strategy `none`, `suppressedBy: { justification: "not_affected",
source: "maintainer-vex", notes: "<package>@<version> (<author>): <justification>" }`, status
`suppressed` in the SBOM, and `not_affected` in the CycloneDX VEX output with the maintainer named in
`detail`. The key is policy-file only: no CLI flag, MCP argument or HTTP field can switch it on, so an
agent cannot trust a maintainer on your behalf.

### What is accepted

A statement is used only if all of these hold. Anything else that names the advisory is reported under
`maintainerVexIgnored` with the reason.

1. The document is valid OpenVEX v0.2.0 (strict, see below) and the declaring package is installed.
2. A product purl names exactly the installed `name@version` of the package that ships the file. A
   document shipped in 1.0.1 cannot vouch for 1.0.0 or 1.0.2.
3. The shipping package is not the vulnerable one. **A package declaring itself not affected by an
   advisory about itself is rejected**, with that reason, even under `trustMaintainerVex`: the party the
   advisory is about does not get to dismiss it.
4. The shipping package depends, directly or through installed packages, on the vulnerable one (by name).
5. If the statement lists subcomponents, one is the vulnerable package (any version, or exactly the
   installed one). Statements about other subcomponents are not about this finding.
6. It is the newest statement about the advisory for that product in that document (ties go to the
   statement that is not `not_affected`), is not dated in the future, and says `not_affected` with an
   OpenVEX `justification`. A free-text `impact_statement` alone is not a justification.
7. The advisory matches by id or alias, in either direction (`name` or any of `aliases`).

### Hardening

Documents are untrusted input read from a directory that supply-chain attacks target. They are parsed
as data; nothing in them is executed, fetched or followed.

- `package.json#vex` is a relative path inside the package (or `true`): no absolute path, URL, `..` or
  backslash, must end in `.json`. The file's real path must stay inside the package's real directory
  (a symlink out is refused) and be a regular file.
- At most 1 MiB, nested at most 12 levels, at most 2000 statements, bounded lists and string lengths.
- Strict schema: unknown keys, a wrong `@context`, bad enum values, non-ISO timestamps or a
  `not_affected` without a justification or impact statement reject the whole document.
- Any `__proto__`, `constructor` or `prototype` key at any depth rejects the document.
- A document that is invalid or unreadable is listed by `vex show` with the reason and never stops the
  scan or a remediation.

### Trust model, honestly

An installed package can already run code on your machine, so reading what it says about its own
dependencies adds little exposure. But a verdict is still a claim by the party who benefits from it, and
a compromised package could use one to hide a vulnerable dependency it ships. That is why it is evidence
by default and a suppression only when you ask. The verdict is as good as the maintainer's analysis:
Autoremediator's own producer writes `not_affected` only from a static scan and only when the author
asserts it. Verdicts are not signed; the document's `author` is whatever the package says. If the
package is published with provenance you have the strongest assurance that the tarball is the author's.
Run `vex show` before you turn the policy on.

## For package authors: `autoremediator maintain`

```bash
autoremediator maintain                                  # audit, assess, show a diff
autoremediator maintain --advisories CVE-2026-1111       # assess specific advisories
autoremediator maintain --assert-not-affected --yes      # write it
autoremediator maintain --trace-file .autoremediator/trace.json
```

Run it in the package you develop. It looks up each advisory (the package manager's audit by default,
or `--advisories`; with `--offline` name them and give `--intelligence-snapshot`), then for each one:

1. **Is it shipped?** A vulnerable package that only your development dependencies bring in is not
   installed by your consumers, so nothing is said about it (`not-shipped`). The lockfile decides; with
   no lockfile it is assumed to be shipped and a note says so.
2. **Does your code reach it?** The same static reachability scan as `reachability`, from your source,
   plus a runtime trace when you pass `--trace-file` (see [Runtime reachability](runtime-reachability.md)).
   A trace can only add reachability: if your tests loaded or called the package, it is reachable.
3. **Decide:**

| Finding | Statement written |
| ------- | ----------------- |
| Reachable | `affected`, with an `action_statement` naming the fixed version when the plan has one |
| Unknown, or not reachable without `--assert-not-affected` | `under_investigation` |
| Not reachable **and** `--assert-not-affected` | `not_affected` with `vulnerable_code_not_in_execute_path` |

`not_affected` is the claim consumers act on, so it needs two things: the scan found no use, and you said
so. The static scan is a heuristic (it does not follow `require(variable)` or plugins loaded by name):
review before you assert.

It then **prepares**, and only writes with `--yes` (or an interactive "y"), like `init`; otherwise it
prints a unified diff and exits `3`. It never publishes, pushes, commits or applies a dependency change.

- **A bump plan** for each advisory, through the same machinery as `plan`. Recorded as a run (with
  `--yes`) that you review with `runs show` and apply with `runs apply`. Without `--yes` nothing is
  recorded.
- **A changeset** `.changeset/maintain-<ids>-<hash>.md`, a patch of your package with a plain-language
  body per advisory, when the repository uses changesets (`.changeset/config.json`). Otherwise it is
  skipped and says so. The name is stable, so running again updates the same file.
- **The OpenVEX file** (`vex.openvex.json`, or the path `package.json#vex` already names), wired into
  `package.json`: `"vex"` is set and the path is added to `"files"` so it ships. Statements for other
  advisories, other versions and anything you wrote by hand are kept; a statement is rewritten only when
  what it says changed, and a run with nothing new leaves your file byte for byte as it was. A file that
  does not validate, or a `vex` path that is unsafe, is a conflict and is left alone.

**The version problem.** A statement is only accepted for the exact version it ships in, but you write it
before that version exists. `maintain` names the *next release*: the current version plus the highest
pending changeset bump for the package (at least a patch). It says what it assumed; pass
`--next-version <v>` if that is wrong. In changesets pre-release mode it refuses to guess and asks for
`--next-version`. Run `maintain` again after the version is fixed: the file in a release must name that
release. `vex show` warns when the project's own file does not name the version in `package.json` (which
is expected between running `maintain` and releasing).

Limits: `affected` and `under_investigation` are interim. When you apply the bump the advisory stops
appearing, and the old statement stays in the file until you remove it (`maintain` does not delete what
it no longer sees). Private packages publish nothing, so nothing is prepared. The `package.json`
rewrite uses your indentation but re-flows short arrays and objects.

## The convention, as a proposal

This is a proposal that could be submitted to the npm and OpenVEX communities. Autoremediator implements
it; nothing here depends on Autoremediator.

**Field.** `package.json` may contain `"vex"`: a path relative to the package root of an OpenVEX
document, or `true` for the default path `vex.openvex.json`. Absent means the package ships none. The
file must be listed in `files` (or otherwise included in the tarball) so that it is in the published
package.

**Format.** An [OpenVEX v0.2.0](https://github.com/openvex/spec) JSON document. Each statement's
`products` names the shipping package by purl at the exact version it ships in
(`pkg:npm/%40scope/name@1.2.3`). To say "my package is not affected by an advisory in my dependency",
the product lists that dependency under `subcomponents` (`pkg:npm/dep`, with or without a version).
`not_affected` statements must carry an OpenVEX `justification`.

**Consumer rules.** A consumer reads the documents of installed packages, treats them as untrusted data,
and uses a statement only when the product matches the installed `name@version`, the shipping package
depends on the package the advisory is about, and the statement is the latest one for that advisory.
A package's statement about an advisory concerning itself is ignored. Using a verdict to suppress
remediation is an explicit local policy decision, never a default.

**Why it is safe.** It adds no execution: a document is data validated against a schema, bounded in size
and depth, read from a path confined to the package. A verdict is bound to one exact version, so a later
(possibly compromised) release cannot inherit an earlier verdict and an older document cannot vouch for
a newer release. A package cannot dismiss advisories about itself. Nothing leaves the machine.

**Limits.** Verdicts are claims by the shipping package's maintainers, unsigned (provenance of the
tarball is the only assurance) and only as sound as their analysis. Matching dependents is by package
name, so a tree with several versions of a package can over-match. A statement says nothing about
packages that are not subcomponents of the shipping package. The maintainer must re-release to change a
verdict; there is no revocation channel other than a new version. Consumers that never opt in lose
nothing and gain the evidence.

## Surfaces

| Surface | Reading | Writing |
| ------- | ------- | ------- |
| CLI | `vex show [--cwd] [--advisory] [--package] [--output-format]` | `maintain [--yes] [--assert-not-affected] [--advisories] [--trace-file] [--next-version] [--offline] [--intelligence-snapshot] [--policy] [--package-manager]` |
| SDK | `readMaintainerVex(options)` | `maintain(options)` |
| MCP tool, `POST /maintainer-vex` | `readMaintainerVex` | not exposed: `maintain` writes files |
| Policy | `trustMaintainerVex` (default `false`) | |
