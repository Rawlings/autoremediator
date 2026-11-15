---
"autoremediator": minor
"@autoremediator/github-app": minor
---

Security hardening of what runs, and with which secrets.

- **Child processes no longer inherit credentials.** Installs, tests, typechecks and every other
  command started through `safeExeca` lose model API keys, `GITHUB_TOKEN`/`GH_TOKEN`, cloud
  credentials, and this tool's own `AUTOREMEDIATOR_*` secrets (JWT secret, API tokens, GitHub App
  private key, webhook secret, signing keys). Registry authentication variables (`NPM_TOKEN`,
  `NODE_AUTH_TOKEN`, `NPM_CONFIG_*`) are kept so private registries keep working. `safeExeca` takes
  `passEnv` to keep a named variable for one command. The GitHub App applies the same rule.
- **Dependency install scripts are skipped by default.** Every install the tool starts passes
  `--ignore-scripts` (`YARN_ENABLE_SCRIPTS=0` for Yarn Berry). New policy key `installScripts: all`
  restores the old behaviour; it is policy-file only and counts as a loosening. `bisect` now ignores
  scripts by default too (`--run-scripts` to opt out).
- **Remote callers pass paths, not code.** Over MCP, HTTP and A2A, `reproductionTest` must be the
  path of an existing file inside the allowed roots, and an inline `policy` is refused. Both used to
  let a caller run a script of their own, or replace the project's policy.
- **Roles.** `verifyRun`, `startAttempt`, `proposePatch`, `verifyAttempt` and `applyRecipe` now need
  `admin` (were `operator`): they run the project's installs and tests, which see the server's
  secrets. New operation field `runsProjectCode`.
- **GitHub App.** The installation token is no longer in the clone URL or the clone's `.git/config`;
  it is sent for the clone through `GIT_CONFIG_*` (needs git 2.31 or later).

- **A saved proof-of-fix script runs in the sandbox** (no network, writes, child processes or
  environment) every time `--proof-of-fix` runs it, not only when `prove` first checked it. If the
  sandbox does not hold on the machine, the phase is a harness failure, never a pass. The script
  must be inside the project. Windows keeps the plain run.
- **Repair agent and promotion.** `classifyPath` now refuses all of `.github/`, `.husky/`,
  `.pnpmfile.cjs`, `.yarnrc*`, `.npmrc`, `.envrc` and git configuration files, and treats
  `*.config.*` and test setup files as build tooling the agent may not edit. An agent cannot create
  new test files. A verified change is re-checked for binary, mode and symlink changes and for
  forbidden paths before it is applied to the project. Tool output and the transcript are redacted
  for token formats and the values of secret environment variables. The agent's secret-file
  denylist gained `.netrc`, `.git-credentials`, `.envrc`, `.yarnrc`, `*.tfvars` and others.
- **Recipes** a dependency ships for itself are no longer read automatically; name the package under
  `recipes.packages` to use them.
- **A project `.npmrc`** can no longer expand environment variables into `registry` or proxy
  settings, and only variables made for npm (matched exactly) into credentials.
- **Run records are validated.** A snapshot path or blob reference that leaves the project, or an
  attempt whose checkout is not in the worktree cache, is refused instead of written or deleted.
- **Smaller fixes.** Static API tokens are compared in constant time and may contain `:`; MCP, A2A
  and job errors are redacted; a snapshot that is not JSON no longer echoes its content; package
  names that start with `-` are refused; the Docker image trusts git only for `/workdir`; the
  `init` workflow pins its actions and the CLI version.

Breaking for remote integrations that sent inline scripts or policies, or used an `operator` token
for the operations above.
