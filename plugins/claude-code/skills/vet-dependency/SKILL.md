---
name: vet-dependency
description: Check an npm package before installing it or after it appears in a diff: known vulnerabilities, exploit signals, whether the installed code is reachable. Use before adding a dependency or when reviewing a lockfile change.
---

# Vet a dependency

- Before adding a package: `guardPackage` with its name (and range). It answers allow, warn or block, and offers a safer alternative. On block, do not install it: say what was found and ask. On warn, tell the user before going ahead.
- For more detail on a package's advisories and exploit probability: `evaluatePackage`.
- When reviewing a change to dependencies: `scanDelta` shows the advisories the change introduces compared with the base.
- To judge how urgent a finding is: `checkReachability` with the package (and the vulnerable symbol if known) says whether project code calls it.

These tools only read; they change nothing.
