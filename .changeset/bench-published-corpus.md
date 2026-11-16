---
"autoremediator-bench": patch
---

The benchmark now includes tasks built from published npm releases and the published advisories for
them, next to the purpose-built fixtures. A corpus pins every served version to the registry's own
integrity hash, the local registry serves the packages exactly as published, and a restore command
rebuilds the tarball cache from the lock. Results are written to one file per mode, without dates in
the name, and rendered as an overview page, a page per mode and a task catalogue; the root README quotes
the headline figures from the same data, and a test fails if any of it drifts.
