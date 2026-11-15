# Recipes

When an upgrade breaks your project and an agent makes it work again, that knowledge is worth
keeping. A **recipe** records it as data: which package, which versions, what broke, and the change
to the code that uses it. The next project (or the next run) that makes the same upgrade tries the
recipe first, and spends no tokens when it works.

Recipes are never code and never trusted. A recipe cannot run anything; it can only say "these exact
lines become those lines". Applying one goes through the same checks as a patch from an agent, and
the verifier still decides whether the result stands.

## How they are used

During [agent repair](plan-and-apply.md#repair-with-an-agent), once the
upgrade is applied in the isolated checkout and the verifier reports that the project is broken:

1. Recipes for this package and these versions are looked up (sources below).
2. Each is tried in turn: matched against your source, turned into a diff, validated, applied to the
   checkout, and judged by the verifier.
3. The first one the verifier accepts is kept, and no model is asked. One that does not match, is
   refused, or does not make the verifier pass is **taken back out exactly**, and the next recipe (or
   the agent) starts from the checkout as it was.

This also happens with no model configured: if the project already has a recipe for the upgrade,
`runs apply` tries it. Without a model and without a recipe, behavior is unchanged. `--no-repair`
turns recipes off along with the agent.

With the tools of a host agent ([MCP](../integrations/mcp-server.md) and HTTP), `startAttempt` lists
the recipes that apply (`recipes` in its result) and `applyRecipe` applies one to the attempt's
checkout and verifies it, undoing it if the verifier rejects it. `listRecipes` shows what is available.

## What a recipe looks like

```json
{
  "schemaVersion": 1,
  "package": "dep",
  "fromRange": ">=1.0.0 <2.0.0",
  "toRange": ">=2.0.0 <3.0.0",
  "observed": { "fromVersion": "1.4.2", "toVersion": "2.0.0" },
  "summary": "f no longer takes a second argument",
  "breaking": [
    { "kind": "diagnostic-TS2554", "message": "Expected 0-1 arguments, but got 2." }
  ],
  "hunks": [
    {
      "before": ["import { f } from 'dep';"],
      "remove": ["f(1, 2);"],
      "add": ["f(1);"],
      "after": []
    }
  ],
  "evidence": {
    "runId": "run_...",
    "attemptId": "attempt_...",
    "agent": "builtin",
    "capturedAt": "2026-11-14T10:00:00.000Z",
    "autoremediator": "0.21.2",
    "checks": [{ "name": "typecheck", "status": "passed" }]
  }
}
```

| Field | Meaning |
| ----- | ------- |
| `package`, `fromRange`, `toRange` | The recipe is for upgrading `package` from a version in `fromRange` to one in `toRange` (semver ranges). |
| `observed`, `summary`, `breaking`, `evidence` | Provenance, for people: the versions it was captured from, what the agent said, what the verifier reported broken (best effort: type-check diagnostics, a failing test, changed import lines), and the checks that passed. Not used for matching. |
| `hunks` | The change: `before` context lines, `remove` lines, `add` lines, `after` context lines. `optional: true` lets a hunk match nowhere. |

### Matching is exact, and fails closed

- A hunk matches where `before + remove + after` appear, line for line and character for character,
  in a tracked `.js`/`.ts` (and variants) source file that imports the package (a quoted `'dep'`,
  `"dep"` or a `dep/subpath`). No fuzz, no whitespace tolerance, no line-number guessing.
- Every non-optional hunk must match somewhere, or **nothing** is applied. Hunks that overlap are
  refused. At most 200 changes in 50 files.
- Files with CRLF line endings or without a final newline are never candidates.
- Changes are written as an ordinary unified diff and go through the same validation as `proposePatch`:
  project source only (never manifests, lockfiles, CI or the policy file), no binary, mode, rename or
  symlink changes, size-capped, `git apply --check`. Then the normal verifier runs.
- A recipe holds only lines of text: line breaks and NUL inside a line are rejected, unknown fields
  are rejected, files over 500 KB are not read, and symlinks are never followed.

## Where recipes come from

| Source | Where | Trusted for |
| ------ | ----- | ----------- |
| This project | `.autoremediator/recipes/<package>/*.json`, committed | Any package. Reviewed like any other file in the repository. |
| A recipes package you name | `recipes: { packages: [...] }` in `.github/autoremediator.yml`; the package's `recipes/**/*.json` (or `autoremediator-recipes/`) | Any package. Naming it is you choosing to trust it. |

```yaml
# .github/autoremediator.yml
recipes:
  packages:
    - "@acme/autoremediator-recipes"
```

A recipe file that fails validation is reported (`recipes list` shows it as unusable) and never
used; it does not hide the valid ones.

A dependency that ships recipes is not a source by itself: a recipe edits your own source files, and
the version being installed is the least trusted code around. Name the package under
`recipes.packages` to use what it ships. Recipes are read from the isolated checkout, where the new
version is installed, so they are tried whenever an attempt runs (a model is configured, or the
project already has a matching recipe from its own directory or a named recipes package).

## Capturing a recipe

When an agent's repair is accepted and applied, autoremediator derives a recipe from the repair's diff
and the verifier's findings and keeps it with the attempt (`recipe.json`; the ledger records
`recipe.captured`). Only project source hunks are kept; dependency files are not part of what was
learned, and new, deleted, renamed or binary files are skipped. Nothing is written to your project
until you say so:

```bash
autoremediator recipes capture --run <runId>            # latest repaired attempt of the run
autoremediator recipes capture --run <runId> --attempt <attemptId>
```

This saves it to `.autoremediator/recipes/<package>/<from>-to-<to>.json`. By default the recipe is for
the same major (or, below 1.0, minor) as the observed upgrade, starting at the observed versions;
widen or narrow it with `--from-range` and `--to-range`. Capturing the same recipe twice saves it
once. Review it, then commit it. If `.autoremediator` is git-ignored (as `autoremediator init` does),
add this to `.gitignore`:

```gitignore
.autoremediator/*
!.autoremediator/recipes/
```

A captured recipe records the code it was made from, so it re-applies where the same code is found
(a call written the same way, the same import line). It is a record, not a refactoring: it does not
generalize, and a recipe that does not match simply is not used. Recipes written by hand, or edited
before they are committed, can be more general than a captured one.

## Commands

```bash
autoremediator recipes list [--package <name>] [--from <v> --to <v>]
autoremediator recipes show <id>
autoremediator recipes capture --run <runId> [--attempt <id>] [--from-range <r>] [--to-range <r>]
autoremediator recipes export --name <npm-name> --out <dir> [--package <name...>] [--package-version <v>]
```

A recipe's id is `<package>#<hash of what it does>`; who captured it and when are not part of it.

## Publishing a recipes package

A recipes package is a normal npm package with its recipes under `recipes/`:

```bash
autoremediator recipes export --name @acme/autoremediator-recipes --out ../autoremediator-recipes
cd ../autoremediator-recipes
# review recipes/ : they change your users' source code
npm publish --access public
```

`export` writes `package.json`, a `README.md` that tells consumers how to use it, and
`recipes/<package>/<file>.json` for each of the project's recipes (or only the ones named with
`--package`). It refuses to write into a non-empty directory and publishes nothing. Consumers install
the package and name it in their policy, as above.

A package that wants to ship migration recipes for itself puts them in `autoremediator-recipes/` at its
root (and lists that directory in `files`). Consumers use them by naming the package under
`recipes.packages`.

## Surfaces

| Surface | Reading | Applying |
| ------- | ------- | -------- |
| SDK | `listRecipes` | `applyRecipe` (an open attempt), `captureRecipe`, `exportRecipes` |
| CLI | `recipes list`, `recipes show` | `recipes capture`, `recipes export` (and automatically in `runs apply`) |
| MCP and HTTP | `listRecipes` (`POST /recipes/list`) | `applyRecipe` (`POST /attempts/recipe`), only inside an attempt's isolated checkout |

`captureRecipe` and `exportRecipes` write files in your project or a directory you name, so they are
SDK and CLI only.

## What is not covered

- The built-in `breakingChangeRefactor` codemods (`rimraf`, `uuid`) are AST-based and rewrite
  whatever call shapes they find. Exact-line recipes cannot express that, so they are unchanged.
- Recipes are exact text. They do not understand code, rename variables or follow different
  formatting; that is what the agent is for.
