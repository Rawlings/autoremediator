---
"autoremediator": minor
---

Runtime reachability: record what your tests actually load and call, and use it in `reachability`.

- **`autoremediator/trace`**, a package export to use as `node --import autoremediator/trace`,
  `NODE_OPTIONS="--import autoremediator/trace"` or `node --require autoremediator/trace`. With
  `AUTOREMEDIATOR_TRACE_FILE` set, every process and worker thread appends JSON lines recording the
  installed packages it loaded (name, version, entry files, who loaded them), for CommonJS and ES
  modules. With `AUTOREMEDIATOR_TRACE_CALLS=1` and `AUTOREMEDIATOR_TRACE_PACKAGES=a,b` it also counts
  calls to those packages' exported functions. It never changes what the program does, never throws
  into it and never writes to stdout or stderr. Classes, frozen exports, `const` ES exports and other
  shapes that cannot be wrapped safely are left alone and reported as `unwrapped` with a reason.
- **`autoremediator trace run [--packages a,b] [--calls] [--out file] -- <command...>`** and SDK
  `traceRun` start a command with the hook in every Node.js process it runs, fold the result into
  `.autoremediator/trace.json` and exit with the command's exit code. CLI and SDK only: it starts a
  program of the caller's choosing, so it is not an MCP tool or HTTP route.
- **`reachability --trace-file`** (SDK, MCP and HTTP `traceFile`, a guarded path) adds
  `evidenceKind` (`static`, `runtime` or `both`) and a `runtime` verdict: `called-in-tests`,
  `loaded-not-called-in-tests`, `loaded-in-tests`, `not-loaded-in-tests` or `no-trace-data`. A package
  the tests never loaded is reported as `not-loaded-in-tests` with a caveat that this is not proof it
  is unreachable. A call observed at runtime can raise a static `not-reachable` to `reachable` (the
  static answer is kept in `staticStatus`); a trace never lowers `reachable`. Without a trace the
  result is unchanged apart from `evidenceKind: "static"`, and `--skip-unreachable` and VEX output do
  not use traces.
