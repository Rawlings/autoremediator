---
"autoremediator": minor
---

Silent-fix radar.

- **`autoremediator radar [--include-transitive] [--limit n] [--max-packages n] [--target latest|minor|patch] [--github] [--model [spec]] [--no-assess]`**,
  SDK `radar`, MCP tool and `POST /radar` (read-only; reader role). For each installed dependency,
  compares the installed version with a newer one and flags the releases in between that look like
  security fixes **before an advisory exists**. Signals are computed locally: a fixed security
  vocabulary over the changelog in the tarball (word boundaries, negation understood, `memory leak` is
  not security; GitHub release notes only with `--github`, unauthenticated and rate-limit aware), code
  differences between the published tarballs (added prototype guards, path containment, traversal and
  length checks, sanitizers, rejections; ReDoS-prone regular expressions and dangerous sinks removed),
  and registry metadata (a predecessor deprecated for security, release bursts). An optional model
  (`--model`, off by default) can add up to 15 points and never subtract.
- Output is a ranked list with a transparent score table, a confidence label (`likely`, `possible`,
  `weak`), the upgrade distance, quoted evidence per flag (`file:line` and at most 200 sanitized
  characters), an OSV cross-check (`now-advisory` with the advisory ids, or `unchecked`) and an
  `assess` rating of the upgrade against your source for the best direct dependencies. It never says a
  vulnerability exists: the wording is "security-relevant change without a published advisory". Exit
  `3` when a `likely` change without an advisory is found.
- Package text is untrusted: control, escape, bidi and tag characters are stripped, evidence is capped,
  and nothing in it selects behaviour except through the fixed keyword and code patterns.
- Network use is bounded (4 packages at once, 120 s per package, 256 MiB in total, 100 packages) and
  `--offline` is refused.
- The in-memory tarball reader can now also return root-level changelog files (`includeDocs`).
- New page `docs/guides/silent-fix-radar.md`, including what it measured on real historical fixes and
  what it misses.
