---
name: vet-dependency
description: Check an npm package before installing it or after it appears in a diff: known vulnerabilities, exploit signals, whether the installed code is reachable. Use before adding a dependency or when reviewing a lockfile change.
---

# Vet a dependency

- Before adding a package: `evaluatePackage` with its name (and version). Report advisories, known exploitation and exploit probability. If it looks unsafe, say so and suggest an alternative instead of installing it.
- When reviewing a change to dependencies: `scanDelta` shows the advisories the change introduces compared with the base.
- To judge how urgent a finding is: `checkReachability` with the package (and the vulnerable symbol if known) says whether project code calls it.

These tools only read; they change nothing.
