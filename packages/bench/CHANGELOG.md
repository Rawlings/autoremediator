# autoremediator-bench

## 0.0.3

### Patch Changes

- 218a1cd: The benchmark harness no longer lets fixture code touch the machine it runs on. Installs pass
  `--ignore-scripts` (trap tasks excepted), consumer tests run under Node's permission model with no
  write, process or network access, the work directory must lie inside the OS temp directory or the
  benchmark's own `.work` directory, child processes get an environment without credentials, and a
  new `screenTarball` check rejects packages with install scripts, native code, links or unsafe paths.
- 218a1cd: The benchmark now includes tasks built from published npm releases and the published advisories for
  them, next to the purpose-built fixtures. A corpus pins every served version to the registry's own
  integrity hash, the local registry serves the packages exactly as published, and a restore command
  rebuilds the tarball cache from the lock. Results are written to one file per mode, without dates in
  the name, and rendered as an overview page, a page per mode and a task catalogue; the root README quotes
  the headline figures from the same data, and a test fails if any of it drifts.
- Updated dependencies [6f54562]
- Updated dependencies [6f54562]
- Updated dependencies [c49929c]
  - autoremediator@0.24.0

## 0.0.2

### Patch Changes

- Updated dependencies [54c0f23]
  - autoremediator@0.23.0

## 0.0.1

### Patch Changes

- Updated dependencies [3ef25c7]
- Updated dependencies [fc66a87]
  - autoremediator@0.22.0
