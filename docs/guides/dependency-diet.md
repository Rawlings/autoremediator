# Dependency diet

Every dependency is code you did not write running in your project, with its own install scripts,
maintainers and future advisories. The cheapest CVE to remediate is the one you never had. `diet`
shows what the project could stop depending on, and can remove the part that is certainly safe.

```bash
autoremediator diet                    # report; changes nothing, needs no network
autoremediator diet --verbose          # also list indirectly used dependencies and every duplicate
autoremediator diet --output-format json
autoremediator diet --apply            # remove the certainly-unused ones, verify, roll back on failure
```

SDK: `analyzeDependencies({ cwd })` and `removeUnusedDependencies(options)`. MCP tool and
`POST /packages/diet`: `analyzeDependencies` (read-only). Removal is deliberately command line and
SDK only, because it writes.

## 1. Unused dependencies

Every dependency declared in `dependencies`, `devDependencies` or `optionalDependencies` that the
source does not import is classified:

| Classification | Meaning |
| -------------- | ------- |
| `used-indirectly` | Not imported, but something names it: a script or CI/git-hook command (its `bin`), a tool config (`.eslintrc`, `.babelrc`, `jest`, `tsconfig` `types` and `extends`, the tool sections of `package.json`), a string (`jest.mock("x")`, a plugin list), the types of a package that is used, a peer of another dependency, `@types/node` in a TypeScript project, a dependency another workspace package uses. |
| `certainly-unused` | Installed, and no import, `require`, `import()`, `require.resolve`, type reference, string, script, config, workflow or command names it, nothing could load it by a runtime-computed name, and every file was read in full. The only classification `--apply` acts on. |
| `probably-unused` | Nothing found, but something the scan cannot see remains possible. The reason says what: it provides a command nothing here runs, it is an optional dependency, a plugin/preset/loader no config names, it is not installed (so its commands and peers are unknown), a file loads modules by a runtime name, a file could not be parsed, or there are no source files. |

Source is parsed with `oxc-parser` (ESM, CommonJS, dynamic `import()`, `require.resolve`,
`import.meta.resolve`, re-exports, `import x = require()`, `typeof import()`, `/// <reference types>`,
JSX pragma). Vue, Svelte, Astro and MDX files are searched for quoted package names. Generated
directories (`dist`, `build`, ...) are skipped only when `.gitignore` says they are not committed.
Monorepo workspace packages are analysed one by one; the root's dependencies count as used when any
member uses them, and a member is covered by the root's scripts and configuration.

Limits: the scan reads names, not behaviour. A package loaded by a tool through a configuration
file format it does not know, or by a script outside the repository, is reported
`certainly-unused` only if no file in the package names it; that is why `--apply` verifies and rolls
back.

## 2. Replaceable micro-packages

`packages/core/src/features/diet/replaceable.json` is a curated table. Each row names the Node built-in
or platform API, the Node versions that have it (`nodeRange`, checked against nodejs.org's API
history and MDN compatibility data), a one-line migration, what differs (`caveat`), and a `source`.
Rows today: `left-pad`, `is-number`, `isarray`, `array-flatten`, `object-assign`, `globalthis`,
`has`, `rimraf`, `mkdirp`, `make-dir`, `uuid` (v4 only), `node-fetch`, `abort-controller`, `pify`,
`os-homedir`.

A package is `replaceable` only when **every** Node version the project declares has the API
(`engines.node`, else `.nvmrc` / `.node-version`, read as a floor). If the range reaches below it the
status is `blocked-by-node`; if the project declares no floor it is `unknown-node`. `uuid` is
replaceable only when the source imports nothing but `v4` (`not-covered` otherwise). `fit:
check-usage` rows behave differently for some calls (for example `rimraf` globs); read the caveat.
Add a row only when the replacement is certain.

## 3. Duplicates

From the lockfile (`package-lock.json` v2/v3 and `pnpm-lock.yaml` v6/v9; yarn, bun and deno
lockfiles are reported as not read): each package installed at more than one version, which parent
pulls each (with the range it asked for) and the verdict:

- `dedupe-within-range`: one installed version satisfies every parent, so `npm dedupe` / `pnpm
  dedupe` or an override to it stays within every range.
- `partly-dedupable`: some copies can move up to a version their parents already accept.
- `needs-override-or-upgrade`: every copy is held by a parent whose range excludes the others.
- `unknown-ranges`: ranges are not on record. A pnpm lockfile holds resolved versions, not ranges
  between packages; they are read from the installed `node_modules/.pnpm` manifests, so install
  first.

Nothing is changed for duplicates.

## 4. Attack-surface score

0 to 100, higher means more code you did not write runs in the project. It is the sum of six capped
components, each printed with its formula:

| Component | Points |
| --------- | ------ |
| Installed packages | `30 * min(1, ln(1 + n) / ln(2001))` |
| Dependency depth | `10 * min(1, (depth - 1) / 9)` (longest shortest path from the project) |
| Packages with install scripts | 2 each, up to 20 (read from installed `package.json`, a `binding.gyp`, or the lockfile's flag) |
| Deprecated packages | 2.5 each, up to 15 (the lockfile's `deprecated` field) |
| Unused and replaceable | 1.5 per certainly-unused + 0.5 per probably-unused + 1 per replaceable, up to 15 |
| Extra installed copies | 0.5 per version beyond the first, up to 10 |

It is a way to compare a project with its own past, not a probability of compromise. Unmaintained
packages are not detected (that needs registry data); no registry lookup is made. Without a readable
lockfile the lockfile-derived parts are zero and the report says the score is a lower bound.

## `--apply`

```bash
autoremediator diet --apply --run-tests
```

Removes only the `certainly-unused` dependencies, per workspace package, with
`npm uninstall --ignore-scripts` or `pnpm remove --ignore-scripts` (other package managers: the
dependencies are listed to remove by hand). It then runs the [verifier](plan-and-apply.md): only
dependency files changed, policy holds, a frozen install succeeds, and the type check (on by default
when a `typecheck` script or `tsconfig.json` exists; `--no-typecheck` turns it off) and the tests
(`--run-tests`) pass. If any check fails, manifests and lockfile are restored from a snapshot taken
first, the restored lockfile is installed again, and the command exits `1`. Verification runs the
project root's commands, so in a monorepo give the root a `typecheck`/`test` script that covers the
packages.
