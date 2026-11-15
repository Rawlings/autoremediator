# Upgrade impact and fix-diff symbols

Two read-only questions about an npm package, answered from the published tarballs and your own
source. Nothing is installed, nothing in the project changes, and no data leaves your machine
beyond the registry requests for the two tarballs (verified against the registry's integrity digest).

| Question | CLI | SDK | MCP tool / HTTP |
| --- | --- | --- | --- |
| How likely is this upgrade to break **this project**? | `autoremediator assess <pkg> --from A --to B` | `assessUpgrade` | `assessUpgrade` / `POST /packages/assess-upgrade` |
| Which exports did a vulnerability fix change? | `autoremediator symbols <pkg> --from A --to B` | `findVulnerableSymbols` | `findVulnerableSymbols` / `POST /packages/vulnerable-symbols` |

Both are **heuristics**. They are deterministic and every result says why, but they read static
source, not behaviour.

## `assess`: upgrade impact

```sh
autoremediator assess chalk --from 4.1.2 --to 5.0.0
autoremediator assess lodash --from 4.17.20 --to 4.17.21 --output-format json
```

It compares the two versions:

- **Public API.** From `.d.ts` files (parsed with oxc-parser) when both versions ship them, else
  from the JavaScript exports (names, kinds, parameter counts, class members; no types). Removed and
  renamed exports and members, changed signatures (required and optional parameters, parameter and
  return types as source text, overloads), kind changes (function to class), changed type aliases,
  removed enum members, new required interface members, changed base types. Formatting and comments
  never count.
- **Package level.** `engines.node`, module format (CommonJS, ESM, dual), the `exports` map, newly
  required peer dependencies.

It then intersects those changes with what your source actually uses: which named imports, which
members of a default or namespace import or `require()` result, which subpaths, with file and line.
A change counts only through code that reaches it. A call with a compatible argument count is not
flagged when a signature gained a parameter.

### The rating

Every finding is worth a fixed number of points, by how the change reaches the project:

| Evidence | Breaking | Possibly breaking |
| --- | --- | --- |
| `project-usage`: your own call or reference sites reach it | 50 | 20 |
| `project-conflict`: your `package.json` provably cannot meet the new requirement (`engines.node`, a peer range) | 50 | 50 |
| `name-match`: only a class or interface member name matches (no type information) | 20 | 8 |
| `opaque-usage`: the module object is passed along or read by computed name, so use cannot be followed | 15 | 15 |
| `unresolved`: a real package-level change whose effect depends on facts we do not have | 15 | 15 |

The rating is **High** if any finding is a breaking change with `project-usage` or
`project-conflict` evidence; otherwise **Medium** if the points total at least 15; otherwise **Low**.
Many soft findings never reach High. The JSON output includes the table (`scoring`), the score, each
finding's points, and `unreachedChanges`: how many breaking and possibly-breaking changes your code
does not touch.

### What it cannot see

- Behaviour: a function with the same signature can change what it does.
- Types for untyped packages (it falls back to JavaScript exports), and `@types/*` packages.
- Class instance members are matched by member name only (`name-match`), and shadowed identifiers and
  aliasing through reassignment are not tracked.
- A project that does not import the package directly (only through other packages): only
  package-level findings apply, and the result says so.
- `require()` of an ESM-only package works on Node 20.19 and 22.12 or later unless the package uses
  top-level await, so it is rated `possibly-breaking`, not breaking.

## `symbols`: candidate vulnerable symbols

```sh
autoremediator symbols lodash --from 4.17.20 --to 4.17.21 \
  --cwe CWE-94 --advisory-text "Command injection via the template variable option"
```

It diffs the vulnerable version against the fixed one and lists the **exports whose implementation
changed**, including exports that call a changed internal function (with the call distance) and
exports the fix removed. Definitions are compared by a canonical form of their syntax tree, so
reformatting, comments, quote style and parentheses do not count. It follows ESM exports,
re-exports, `export *`, CommonJS `exports.x =`, `module.exports = {…}` and
`module.exports = require(…)`, `Object.defineProperty(exports, …)`, `exports` maps and `main`.

**A changed export is a candidate, not proof it was the vulnerable one.** Refactors, helper changes
and unrelated fixes in the same release also show up. Ranking:

- the export's own change ranks above one reached through a changed helper, above one whose module
  imports a changed module; a changed constant ranks low; a bumped version string is ignored;
- with `--advisory-text`, a symbol named in the text and added identifiers the text mentions rank
  higher;
- with `--cwe` (or `CWE-n` in the text), identifiers and literals the fix adds are matched against
  a small static table of vocabulary typical of that weakness class (regular expressions and limits
  for CWE-1333, escaping for CWE-79, and so on).

Every point is listed under `reasons`. Nothing is looked up or invented.

Each candidate is checked against your source with the same reachability analysis as
`autoremediator reachability`, reading the project once (`--no-reachability` skips it).

Weak spots, reported in the `limitations` field: bundles that build their exports dynamically (lodash's
UMD file is found by a namespace-assignment heuristic), changes in code reached only through a call
the analysis cannot follow, and ranking that depends on advisory wording. Changed internal
definitions that no export could be tied to are listed under `changedInternals`.

## Safety

Tarballs are never extracted to disk. They are decompressed in memory under limits (256 MiB
unpacked, 50,000 entries, 4 MiB per source file, 48 MiB of retained source). An entry with an
absolute path or `..`, a bad header checksum or a truncated archive is refused; symbolic and hard
links are skipped and never followed. Both tools use the registry and credentials from your
`.npmrc`, and over MCP and HTTP `cwd` is confined to the allowed roots like every other path.
