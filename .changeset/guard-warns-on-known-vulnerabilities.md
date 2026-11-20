---
"autoremediator": minor
---

`guardPackage`, `autoremediator guard` and the install hook now warn when a package version has
known vulnerabilities, instead of allowing it with an informational finding. A version that is being
exploited still blocks. The report keeps naming the safer version, and the hook asks before an
install of an affected version goes ahead.
