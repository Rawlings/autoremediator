# Safety

Autoremediator edits dependency files and runs your package manager and tests. These are the
guarantees it makes, where it trusts input, and what it talks to.

## Guarantees

- **Rollback.** If an install, test, type check or validation step fails, the manifest and lockfile
  are restored. Only files the run changed are touched, and only inside the project.
- **No silent success.** Anything not fixed is reported with a reason. Nothing is reported as fixed
  that was not verified.
- **Previews write nothing.** `--dry-run` and `--preview` never modify the project and cannot be
  combined with pull request creation.
- **Sanitized subprocesses.** Package managers, git and test commands run with a reduced
  environment. Variables such as `NODE_OPTIONS` and `LD_PRELOAD` are not inherited.
- **Model output is untrusted.** A generated patch must apply to the real source, pass a syntax
  check and clear a confidence threshold, and it is written as a reviewable `.patch` file. Tests
  written by a model are never executed.
- **Invalid configuration fails.** Unknown policy keys, bad values and malformed snapshots are
  errors, not warnings.
- **VEX is conservative.** `toCycloneDxVex` reports `resolved` only when every affected package was
  fixed, and `not_affected` only from explicit [suppressions](reference/policy-file.md#suppressions).

## Limits

- Tests and type checks only catch what your project tests. A green run is not proof the upgrade is
  safe; review the diff.
- [Reachability](guides/scanners.md#checking-before-you-install) is a static import scan. It cannot see dynamic
  requires or configuration-driven loading, so it prioritizes work and never marks a CVE
  `not_affected`. A [runtime trace](guides/runtime-reachability.md) of your tests adds evidence, but a package
  that no test loads is still not proof that it is unreachable.
- Version bumps trust the npm registry. Use
  [supply-chain constraints](reference/policy-file.md#constraints) to filter new, script-bearing or
  unattested versions.

## Trust boundaries

The CLI and SDK trust their caller. The [MCP server](integrations/mcp-server.md) and
[HTTP server](integrations/http-server.md) do not:

- `changeRequest.tokenEnvVar` and `changeRequest.githubApiUrl` are removed from their input, so a
  caller cannot redirect the server's GitHub token.
- The HTTP server requires authentication, JSON bodies of at most 1 MiB, a local `Host` header, and
  confines path options to allowed roots.
- Change requests are refused together with `dryRun`, `preview` and `planRemediation` on every
  surface.

The [GitHub App](integrations/github-app.md) accepts only relative `cwd` values inside the checkout
and verifies webhook signatures.

## Serving MCP over HTTP

`autoremediator-mcp --http` is stateless, loopback-only, host-checked and role-gated like the HTTP
API; see [MCP server](integrations/mcp-server.md#over-http). Anyone who can reach it with an `admin`
token can change your project, as with the HTTP API, so keep tokens secret and put TLS in front of it
if it leaves the machine.

## Agent repair

With a model configured, an agent can edit your project's source to adapt it to an upgrade (see
[Repair with an agent](guides/plan-and-apply.md#repair-with-an-agent)). It works in a separate git
checkout, with tools that cannot touch dependency files, CI, the policy, credentials or anything
outside the checkout, under step, command, time and token limits. Its result is applied only if the
deterministic verifier accepts it, and again checked once it is in your project. The files it reads
and your checks' output are sent to your model provider.

## Runs on disk

`planRemediation` and `applyPlan` keep a record under `.autoremediator/runs/`, including a copy of
your manifests, lockfiles and patch files taken before the first change. Rollback restores from it
and refuses if the project changed since. See [Plan, apply and roll back](guides/plan-and-apply.md).

## Network access

Remediation contacts public, read-only endpoints. No repository code or credentials are sent to
them.

| Host | Purpose |
| ---- | ------- |
| `api.osv.dev` | OSV advisories |
| `api.github.com` | GitHub Advisory Database; pull requests when requested |
| `services.nvd.nist.gov` | NVD severity (CVSS) |
| `www.cisa.gov` | CISA Known Exploited Vulnerabilities |
| `api.first.org` | EPSS scores |
| `registry.npmjs.org` | Package versions, metadata and source, or the registry set in your `.npmrc` (see below) |

### Registries and credentials

Package metadata and source come from the registry your project is configured for: `registry` and
`@scope:registry` in the project `.npmrc` (then the user `.npmrc`, or `NPM_CONFIG_USERCONFIG`), and
`npm_config_registry` over both. `_authToken` and `_auth` entries are sent only to URLs under the
registry prefix they were written for, never over plain `http` except to `localhost`, and
`${VAR}` references are read from the environment. Downloaded tarballs are checked against the
registry's integrity digest before they are unpacked. Yarn Berry's `.yarnrc.yml` is not read.

Your package manager contacts its own registry when it installs. A configured model receives the advisory summary and the
published source of the vulnerable package (not your own code). `--offline` disables the advisory
requests; see [Offline use](guides/offline.md).

To report a vulnerability in Autoremediator, see the [security policy](../.github/SECURITY.md).
