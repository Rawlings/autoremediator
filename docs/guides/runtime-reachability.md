# Runtime reachability

`autoremediator reachability` reads your source. That misses a lot: `const dep = require("dep");
dep.run()` is not followed, and neither is a plugin loaded by name. A trace answers the same question
from the other side: run your tests, and record which dependencies were actually loaded and, for the
packages you pick, which of their functions were actually called.

Everything runs on your machine. The hook writes a local file; nothing is sent anywhere.

## Record a trace

```bash
# Which dependencies do my tests load?
autoremediator trace run -- node --test

# Which functions of the packages you name do they call?
autoremediator trace run --packages lodash,minimist --calls -- pnpm test
```

`trace run` starts the command with a hook in every Node.js process it starts (through
`NODE_OPTIONS`), including test-runner child processes and worker threads, then folds what they
recorded into `.autoremediator/trace.json` (change it with `--out`). The command's own output is
untouched and `trace run` exits with the command's exit code, so it can replace the command in CI. A
failing test run still produces a trace, and the trace says it failed.

The command is run without a shell: `-- sh -c "npm test && npm run e2e"` if you need one. Put `--`
before the command, or put every `trace run` option before it. `--timeout <seconds>` stops a hung
run. With `--output-format json` stdout holds only the result and the command's own stdout moves to
stderr.

```text
Traced: node main.cjs (exit 0, 1 process(es))
Packages loaded: 7 (6 by your own code, 1 only through other packages)
  cjs-class@3.1.0: no exported function called
    not counted: Widget (class-or-constructor-function)
  cjs-fn@1.2.3: default x2, helper x1
  cjs-obj@2.0.0: add x2, self x1
Trace written to .autoremediator/trace.json
```

### Without the CLI

The hook is also a package export, so you can use it directly:

```bash
AUTOREMEDIATOR_TRACE_FILE=trace.jsonl node --import autoremediator/trace app.js
AUTOREMEDIATOR_TRACE_FILE=trace.jsonl NODE_OPTIONS="--import autoremediator/trace" npm test
AUTOREMEDIATOR_TRACE_FILE=trace.jsonl node --require autoremediator/trace app.cjs
```

| Variable | Meaning |
| -------- | ------- |
| `AUTOREMEDIATOR_TRACE_FILE` | Where to append records (JSON lines). The hook does nothing without it |
| `AUTOREMEDIATOR_TRACE_PACKAGES` | Comma-separated packages whose exports are wrapped to count calls |
| `AUTOREMEDIATOR_TRACE_CALLS` | `1` to count calls to the exports of those packages |

Every process (and worker thread) appends its own lines, so any number of them can write to one
file. The raw file is a valid `traceFile`: it is folded when read. The hook never writes to stdout
or stderr, never throws into your program, and does nothing if it cannot write the file. If a
process is killed by a signal (test runners do this to their workers) it can lose its newest data:
new packages are written within about 50 ms of being seen, call counts every 500 ms and at exit.

## Use it

```bash
autoremediator reachability --package lodash --symbol template --trace-file .autoremediator/trace.json
```

The same `traceFile` option exists on the SDK's `checkReachability` and on the MCP tool and
`POST /reachability` (a path inside the allowed roots). The result gains:

- `evidenceKind`: `static` (no trace), `both`, or `runtime` (the static scan found no source to scan).
- `runtime.verdict` with a `reason`, the `versions` loaded, who loaded them (`loadedBy`), the
  `calls` counted for the symbol, and a `caveat`.

| `runtime.verdict` | Meaning |
| ----------------- | ------- |
| `called-in-tests` | The symbol (or, with no symbol, any export of the package) was called |
| `loaded-not-called-in-tests` | Calls were counted for the package and none reached the symbol |
| `loaded-in-tests` | The package was loaded, but calls were not counted for it (add `--packages` and `--calls`), or the symbol is one that cannot be counted (see below) |
| `not-loaded-in-tests` | The traced command never loaded the package |
| `no-trace-data` | No process reported to the hook, so nothing can be concluded |

**`not-loaded-in-tests` is not proof that a package is unreachable.** It says the tests did not load
it. Production code paths the tests do not cover are invisible to a trace, and the `caveat` on every
verdict says so. For that reason runtime evidence only ever adds reachability:

- If the static scan says `not-reachable` and the trace saw the symbol called, `status` becomes
  `reachable` with `reachabilityBasis: "runtime-call-observed"`, and the static answer is kept in
  `staticStatus`. (With no symbol, a load is enough: `runtime-load-observed`.)
- A trace never turns a static `reachable` into `not-reachable`.
- Remediation (`--skip-unreachable`) and the VEX output do not use traces. `traceFile` only affects
  the `reachability` command, `checkReachability` and its MCP and HTTP forms.

## What is and is not counted

Loading is recorded for every installed package (anything under a `node_modules` directory), for
CommonJS and ES modules, with its version from its own `package.json`, the entry files the code
loaded, and who loaded it (`(app)` for your own code, or the package that required it). Packages
linked from outside `node_modules` (workspace links) are not recorded.

Call counting wraps what a package exports so each call is counted and then forwarded unchanged. It
is opt-in because it adds overhead (below) and rewrites the package's exports as seen by importers.
What it covers:

- CommonJS: the function a module exports (counted as `default`, with its function properties by
  name), or the function properties of an exported plain object, counted when read. Exports are not
  modified; importers receive a wrapper.
- ES modules: exported function declarations, and `let`/`var` bindings holding functions, counted
  after the module evaluates, including functions re-exported through `export *` and
  `export { a as b } from "./x.js"` (counted under both names). Calls from inside the package are
  counted too.

What is skipped, and reported under `unwrapped` with a reason instead of being silently missed:

| Reason | Why |
| ------ | --- |
| `class-or-constructor-function` | A wrapper is a different object from the class, so `instance.constructor === Class`, `new.target` checks and static private fields would behave differently. Classes and functions with prototype methods are never wrapped |
| `frozen-export` | A frozen object's properties cannot be replaced by a wrapper |
| `const-binding` | An ES module `export const f = ...` cannot be reassigned from outside |
| `anonymous-or-expression-export` | `export default function () {}` and `export default expr` have no binding to rewrite |
| `namespace-reexport`, `reexport-of-another-package` | The functions live elsewhere |
| `export-is-not-a-plain-object`, `export-is-not-an-object-or-function` | Nothing to wrap safely |

A package that is loaded twice in one process under different identities, or a function the package
holds a private reference to before it is wrapped, can have calls that are not seen. Counting is
depth one: `lodash.template` is counted, a function on an object that is itself a property of the
export (`lodash.fp.map`) is not.
A re-export target that an unrelated module loaded before the entry that re-exports it is not
instrumented.

ES module hooks need Node.js 22.15 or later (`module.registerHooks`); on older runtimes only
CommonJS is observed and the trace says so (`partialEsm`).

## Overhead

Measured on this repository's CLI (a module-heavy start-up), median of 15 runs, Node.js 26, macOS:

| | Start-up |
| --- | --- |
| No hook | 180 ms |
| Hook loaded, `AUTOREMEDIATOR_TRACE_FILE` unset | 181 ms |
| Tracing loads | 216 ms (+36 ms) |
| Tracing loads and counting calls for two ES-module packages | 327 ms (+147 ms; parsing the packages' sources) |

A wrapped call costs about 25 ns more than a call of a trivial function (10 million calls: 6 ms
unwrapped, 261 ms wrapped). Without `--calls` nothing is wrapped and calls cost nothing.

## SDK

```ts
import { traceRun, checkReachability } from "autoremediator";

const run = await traceRun({
  command: ["node", "--test"],
  packages: ["lodash"],
  calls: true,
  output: "inherit", // "capture" (default) returns stdout/stderr; "stderr" sends stdout to stderr
});
// run.exitCode, run.traceFile, run.report

const reach = await checkReachability({
  packageName: "lodash",
  symbol: "template",
  traceFile: run.traceFile,
});
```

`traceRun` starts a program of your choosing, so it is deliberately not an MCP tool or HTTP route.
Like every subprocess Autoremediator starts, the command does not receive `NODE_PATH`, `LD_PRELOAD`
or similar variables that change how a program loads code.
