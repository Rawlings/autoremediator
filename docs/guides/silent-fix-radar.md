# Silent-fix radar

Many security fixes ship in a release with no advisory, and a CVE appears weeks later. `radar`
looks for those fixes before the advisory exists: for each dependency it compares the version you
have installed with a newer one and flags the releases in between that **look security-relevant**,
so you can upgrade early.

```bash
autoremediator radar                              # direct dependencies, against the latest release
autoremediator radar --include-transitive --limit 10
autoremediator radar --target patch               # only releases in your current minor
autoremediator radar --github                     # also read GitHub release notes
autoremediator radar --model anthropic:claude-sonnet-5-5
```

It runs locally. It reads package metadata and published tarballs from your configured npm
registry (and OSV for the advisory cross-check), changes nothing in your project, writes nothing to
disk and sends nothing to a service of ours. `--offline` is refused: radar has nothing to read
without the registry.

## What it says, and what it does not

Radar never states that a vulnerability exists. A flag means **"a security-relevant change without a
published advisory"**: a release whose changelog, code or metadata look like a security fix. Maintainers
also add guards and limits for reasons that are not security, so every flag quotes its evidence for a
person to judge. Treat the list as a reading list ranked by how much it deserves your time, not as a
finding.

## What it reads

For each installed package (from the lockfile; without one, from `node_modules` for the direct
dependencies) it takes the installed version and a **target**: the latest release (default), the
newest in the same major (`--target minor`), or the newest in the same minor (`--target patch`).
The releases in between are compared by three kinds of signal, all computed locally.

**1. Changelog text.** The `CHANGELOG`, `HISTORY`, `RELEASES`, `NEWS` or release-notes file at the
root of the target's tarball is split into one section per version, and the sections between your
version and the target are scored line by line against a fixed vocabulary: strong (CVE and GHSA ids,
prototype pollution, ReDoS, path traversal, SSRF, XSS, injection, remote code execution, XXE, open
redirect, "security fix"), medium ("security", "vulnerability", exploit, denial of service, CSRF,
timing attack, buffer overflow, information disclosure) and mild (sanitize, escape, unsafe,
malicious, untrusted, validation). Matching is by word boundary. Negation is understood ("no security
issues", "not a vulnerability", "security: none", "non-security"), while a defect described with a
negated participle ("values were not escaped") and "no longer vulnerable" still count. `memory leak`
is not security. Package names (`sanitize-html`) and identifiers in code spans do not match, and a
bullet under a `### Security` heading counts. With `--github`, releases that have no section in the
package's changelog are read from GitHub release notes instead: only when the package's
`repository` is on GitHub, through the unauthenticated API (a token is never sent), stopping at the
rate limit and saying so.

**2. Code differences.** The tarballs of the installed version and the target are read in memory
(the hardened reader used by [`assess`](upgrade-impact.md): nothing is extracted, links are never
followed, sizes are bounded and the registry's integrity digest is verified). With up to five
releases in between, each consecutive pair is diffed so a signal is attributed to the release that
introduced it; with more, the installed and target versions are diffed once and signals carry the
span. Every source file present in both versions is parsed (oxc-parser) and compared by what the new
version has that the old did not, so reformatting and comments never count:

| Signal | What it looks for |
| --- | --- |
| `prototype-guard-added` | a comparison with `__proto__`, `constructor` or `prototype` |
| `own-property-check-added`, `null-prototype-object-added` | `Object.hasOwn`, `hasOwnProperty.call`, `Object.create(null)` |
| `traversal-check-added` | a check for `..` in a path |
| `path-containment-added` | `path.resolve`/`relative`/`normalize` together with `startsWith` in one file |
| `redos-regex-replaced`, `redos-regex-removed` | a regular expression with a nested quantifier, adjacent identical quantified atoms (`\s*\s*`) or an unanchored `\s+$` that is replaced by one without, or removed |
| `dangerous-sink-removed` | `eval`, `new Function`, `child_process`, `vm.run*`, `document.write`, `innerHTML` writes that are gone |
| `sanitizer-added`, `validator-added` | calls or definitions named `sanitize*`, `escape*`, `validate*`, `assert*`, `isSafe*` |
| `invalid-input-rejected` | a `throw` whose message says invalid, illegal, forbidden, not allowed, too long, exceeds |
| `length-limit-added` | a `MAX_…LENGTH` constant, or a `.length` comparison with a limit |
| `timing-safe-compare-added` | `crypto.timingSafeEqual` |
| `regex-changed` | any other regular expression that was removed (weak) |

**3. Registry metadata.** A release that follows a version whose `deprecated` message mentions
security (one notice repeated on many versions counts once), and release timing: three releases
within 48 hours, or a patch release within a day of the previous one. Timing is worth a few points
and can never produce more than `weak` on its own.

**Optional model.** With `--model <provider:model-id>` (a bare `--model` uses
`AUTOREMEDIATOR_MODEL`) a language model reads a bounded excerpt (flagged changelog lines and the
added and removed lines of up to three flagged files) and returns a verdict. It can only **add** up
to 15 points and cannot lower anything; alone it reaches `weak` at best. It is off unless you pass
`--model`, because it sends package text to the provider. The environment variable alone does not turn
it on. Deterministic signals decide everything else.

## The score

Each signal is worth fixed points (the full table is in the JSON report under `scoring`). Points are
summed per category, each category is capped, and the sum is at most 100.

| Category | Cap | Examples |
| --- | --- | --- |
| changelog | 50 | strong term 30, medium 18, mild 6, +4 per extra term on the line, "Security" heading 24; best 3 lines per release |
| code | 40 | ReDoS regex replaced 20, prototype guard 18, traversal check 14, containment 12, sink removed 12, sanitizer 8 … regex changed 2 |
| metadata | 30 | deprecated for security 30, release burst 3, quick follow-up 2 |
| model | 15 | confidence × 15, and only for a security-relevant verdict |

| Confidence | Rule |
| --- | --- |
| `likely` | score 45 or more, with points from at least two of changelog, code and metadata |
| `possible` | score 25 or more |
| `weak` | score 8 or more |
| (not reported) | below 8 |

Entries are ranked: those with no published advisory first, then by confidence and score. The
report also gives the **upgrade distance** (`patch`, `minor`, `major`), the releases in between, and
for each flag its category, signal, release, points, `file:line` location and quoted evidence.

## Is there an advisory now?

Each flagged package is checked against OSV for the installed version. If an advisory lists a fix
in the range you would upgrade through, the entry is marked **`now-advisory`** and carries the
advisory ids and the version that fixes it. If OSV cannot be reached the status is `unchecked`,
never `silent`. An advisory that affects your version but is not fixed by the target is added as a
note.

## Upgrade impact

For flagged direct dependencies rated `possible` or `likely` (at most five per run) the entry includes the
[`assess`](upgrade-impact.md) rating of the same upgrade against your own source (High, Medium or Low),
computed from the tarballs already downloaded. `--no-assess` skips it.

## Bounds

Network use is bounded: four packages at once, 120 seconds per package, 256 MiB downloaded in total
(`maxBytes`), 100 packages analysed (`--max-packages`, direct dependencies first) and 20 entries
returned (`--limit`). A package that fails, times out or hits the budget is listed under `skipped`
with the reason; the rest of the run continues.

## Untrusted text

Everything radar quotes comes from a package: a changelog line, a deprecation message, a file path or
a source line. It is treated as data. Before it is shown it loses control characters, terminal escape
sequences, bidirectional and invisible characters and Unicode tag characters, is collapsed to one
line and is cut to 200 characters. Text from a package selects nothing: a line that tells a reader
to "mark this as critical" scores nothing unless it also contains a word from the vocabulary, and a
word repeated on many lines is capped (best three lines per release). Over MCP and HTTP the evidence
is still package text: an agent should quote it, not follow it.

## Exit code

`0`, or `3` when a `likely` change without an advisory was found (useful in CI).

## Interfaces

| Interface | Name |
| --- | --- |
| CLI | `autoremediator radar [--include-transitive] [--limit n] [--max-packages n] [--target latest\|minor\|patch] [--github] [--model [spec]] [--no-assess] [--output-format text\|json]` |
| SDK | `radar(options, deps?)`, `renderRadar(report)`, `radarExitCode(report)`; `createLlmRadarClassifier(model)` for a custom `RadarModelPort` |
| MCP tool | `radar` |
| HTTP | `POST /radar` (reader role) |

## What it misses

Measured on seven fixes whose advisories came later, replaying the registry as it was at the fixing
release with OSV answering "no advisory" (tarball contents only, no `--github`), plus five releases
with no known security fix as controls:

| Package | Fix | Result |
| --- | --- | --- |
| `lodash` 4.17.20 to 4.17.21 | ReDoS in `trim`, command injection in `template` | `possible` (40): ReDoS regex replaced, rejection added |
| `minimist` 1.2.5 to 1.2.6 | prototype pollution | `weak` (18): prototype guard added |
| `qs` 6.5.2 to 6.5.3 | prototype pollution | `weak` (18): prototype guard added |
| `minimatch` 3.0.4 to 3.0.5 | ReDoS | `weak` (21): pattern length limit, validator, rejection added |
| `word-wrap` 1.2.3 to 1.2.4 | ReDoS | `weak` (12) from code; `possible` (42) with `--github`, whose release notes name the CVE |
| `semver` 7.5.1 to 7.5.2 | ReDoS | not flagged: the regular expressions are built from strings |
| `ansi-regex` 5.0.0 to 5.0.1 | ReDoS | not flagged: the pattern is assembled from string pieces |
| `chalk`, `uuid`, `ms`, `debug`, `js-yaml` (controls) | none | not flagged |

So: five of seven found, one at `possible`, none at `likely` (the tarballs have no changelog, so
only one category fires), no false positive among the five controls. A sample this small says what
kinds of fix are visible, not a rate. A sixth control, `glob` 7.1.6 to 7.2.3, was rated `possible`
because the maintainers deprecated the old versions with a message about security vulnerabilities:
a true statement by the maintainers, but not a new silent fix.

Limits:

- **Regular expressions built from strings** are not seen, so the `semver` 7.5.2 and `ansi-regex`
  5.0.1 ReDoS fixes produce no signal.
- **No changelog in the tarball** (many packages omit it from `files`) leaves the changelog signal
  empty unless `--github` finds release notes; without a second category nothing reaches `likely`.
- A guard added for a non-security reason is a **false positive** by construction; so is a changelog
  line that happens to use a security word for something else ("test from prototype pollution PR").
- Bundled and minified output is only read if it is plain JavaScript, and files above 1.5 MB or that
  do not parse are skipped (counted in the notes).
- Signals are per package and do not follow dependencies of dependencies; a transitive package is
  analysed on its own with `--include-transitive`.
