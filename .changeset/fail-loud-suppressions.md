---
"autoremediator": patch
---

`--suppressions-file` now fails on a missing file, invalid YAML or an invalid entry. Previously it silently loaded no suppressions.
