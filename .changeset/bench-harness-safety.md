---
"autoremediator-bench": patch
---

The benchmark harness no longer lets fixture code touch the machine it runs on. Installs pass
`--ignore-scripts` (trap tasks excepted), consumer tests run under Node's permission model with no
write, process or network access, the work directory must lie inside the OS temp directory or the
benchmark's own `.work` directory, child processes get an environment without credentials, and a
new `screenTarball` check rejects packages with install scripts, native code, links or unsafe paths.
