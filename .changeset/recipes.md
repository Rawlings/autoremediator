---
"autoremediator": minor
---

Recipes: what an agent learned when it repaired an upgrade is kept as data, so the next project (or run)
does not spend tokens learning it again. See `docs/guides/recipes.md`.

- A recipe is a JSON document (`schemaVersion`, `package`, `fromRange`, `toRange`, what broke, the
  consumer-code change as context-anchored `before`/`remove`/`add`/`after` hunks, and the verifier
  evidence). It is never code and never trusted: hunks are matched against project source with exact
  context (no fuzz; nothing is applied unless every required hunk matches), turned into an ordinary
  unified diff, and put through the same validation as `proposePatch` (project source only, no
  binary/mode/rename/symlink, `git apply --check`), then judged by the normal verifier. A recipe the
  verifier rejects is taken back out exactly.
- `runs apply` (`applyPlan`) tries matching recipes in the repair checkout before asking the agent
  anything, and also when no model is configured but the project already has a matching recipe.
  `--no-repair` / `repair: false` turns recipes off with the agent.
- Sources: the project's committed `.autoremediator/recipes/<package>/*.json`; packages named in the
  policy (`recipes: { packages: ["@org/autoremediator-recipes"] }`, trusted for any package); and
  `node_modules/<pkg>/autoremediator-recipes/`, trusted only for recipes about that same package.
  Symlinks are never followed; invalid files are reported, not used.
- An accepted agent repair now leaves a derived `recipe.json` with its attempt (ledger event
  `recipe.captured`). New CLI: `recipes list | show | capture | export` (`capture` saves it into
  `.autoremediator/recipes/`; `export` writes a publishable npm package skeleton and publishes
  nothing).
- New operations `listRecipes` (read-only; SDK, MCP, `POST /recipes/list`) and `applyRecipe`
  (SDK, MCP, `POST /attempts/recipe`; changes only an open attempt's isolated checkout and undoes
  the recipe if the verifier rejects it). `startAttempt` lists the recipes that apply (`recipes`).
  SDK also exports `captureRecipe` and `exportRecipes` (they write files, so they are not MCP or HTTP).
- New policy key `recipes.packages`.
- `proposePatch` validation now lives in one shared function used by recipes too; behavior unchanged.
