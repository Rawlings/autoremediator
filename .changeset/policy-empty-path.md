---
"autoremediator": patch
---

Fix: the project's `.github/autoremediator.yml` was ignored by the version-bump and override tools during a normal run. The pipeline passed them `policy: ""`, which `loadPolicy` treated as an explicit path that does not exist and answered with the defaults, so `allowMajorBumps: true` (and every other policy setting the tools read) had no effect there. An empty path now means "none given" and the default policy file is read. Found by the new benchmark in `bench/`.
