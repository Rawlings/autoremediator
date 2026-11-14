# Integrations

All surfaces call the same SDK functions, so behavior and options match everywhere. Option names are
identical across the SDK, CLI (kebab-case flags), MCP and HTTP.

## GitHub Action

```yaml
- uses: actions/checkout@v5
- uses: rawlings/autoremediator@v1
  with:
    audit: true                 # or scan-file: ./npm-audit.json, or cve-id: CVE-2021-23337
    create-pull-request: true
    pull-request-branch: chore/autoremediator
  env:
    GH_TOKEN: ${{ github.token }}
```

Exactly one of `audit`, `scan-file`, `cve-id` (or `update-outdated`) selects what to remediate.
Other inputs: `dry-run`, `run-tests`, `ci`, `policy`, `package-manager`, `cwd`, `format`,
`summary-file`, `model`, `containment-mode`, `simulation-mode`, `offline`, `intelligence-snapshot`,
`include-transitive`, `node-version` (default 26), `token`.

- `create-pull-request` opens a pull request unless `dry-run` is set. `pull-request-branch` is a
  branch *prefix* (the branch is `<prefix>/<cve-ids>-<random>`, default `autoremediator`) and
  `pull-request-title` a title prefix.
- Outputs: `summary-file`, `pull-request-url`.
- The `model` input needs the matching `@ai-sdk/<provider>` package and that provider's API key in
  the job environment; without it, patch generation is unavailable.

For a ready-made nightly pull request, call the reusable workflow
[`reusable-remediate-from-audit.yml`](../.github/workflows/reusable-remediate-from-audit.yml); the
templates in [`.github/workflow-templates`](../.github/workflow-templates) show nightly PR,
enforcement-gate and SARIF-upload setups.

## MCP server

`autoremediator-mcp` speaks MCP over stdio:

```json
{ "mcpServers": { "autoremediator": { "command": "npx", "args": ["-y", "-p", "autoremediator", "autoremediator-mcp"] } } }
```

Tools: `health`, `remediate`, `planRemediation`, `remediateFromScan`, `remediatePortfolio`,
`updateOutdated`, `listPatchArtifacts`, `inspectPatchArtifact`, `validatePatchArtifact`,
`checkReachability`, `evaluatePackage`, `scanDelta`, `toVex`, and the async job tools
`submitRemediateJob`, `submitScanJob`, `submitPortfolioJob`, `pollJob`. `changeRequest.tokenEnvVar`
and `changeRequest.githubApiUrl` are ignored here; credentials come from the host environment.

## HTTP server

```bash
AUTOREMEDIATOR_API_TOKENS="admin:s3cret" node node_modules/autoremediator/dist/openapi/server.js --port 3000
```

Plain HTTP on `127.0.0.1`; terminate TLS in a reverse proxy if you expose it. The OpenAPI document
is served at `GET /openapi.json`.

| Route                                                                              | Role     |
| ---------------------------------------------------------------------------------- | -------- |
| `GET /health`, `GET /openapi.json`                                                  | public   |
| `GET /jobs/:id`, `POST /vex`, `POST /patches/list`, `/patches/inspect`, `/patches/validate` | reader   |
| `POST /plan-remediation`                                                            | operator |
| `POST /remediate`, `/remediate-from-scan`, `/remediate-portfolio`, `/update-outdated`, `/jobs/remediate`, `/jobs/scan`, `/jobs/portfolio` | admin    |

Secure by default:

- **Authentication is required.** Configure `AUTOREMEDIATOR_API_TOKENS="role:token,…"` (static
  bearer tokens) and/or `AUTOREMEDIATOR_JWT_SECRET` (HMAC-SHA256 JWTs with a `role` claim).
  Otherwise everything except health and the spec returns `503`. `AUTOREMEDIATOR_INSECURE_NO_AUTH=1`
  opts out, for local development only.
- `POST` bodies must be `application/json` and at most 1 MiB (`AUTOREMEDIATOR_MAX_BODY_BYTES`).
- The `Host` header must be `127.0.0.1`, `localhost` or `[::1]` (`AUTOREMEDIATOR_ALLOWED_HOSTS` to
  extend), which blocks DNS-rebinding.
- Path options in request bodies (`cwd`, `inputPath`, `patchesDir`, `policy`, …) must resolve,
  after symlinks, inside the server's working directory (`AUTOREMEDIATOR_ALLOWED_ROOTS` to extend).
- `changeRequest.tokenEnvVar` and `changeRequest.githubApiUrl` are ignored.

Jobs (`/jobs/*`) are held in memory only: they are lost on restart and old finished jobs expire.

## GitHub App

A webhook server that remediates repositories on `check_suite` and `workflow_dispatch` events.

1. Configure the server with the variables in [`.env.example`](../.env.example), then start it
   (`pnpm --filter @autoremediator/github-app start`, or `Dockerfile.github-app`).
2. Open `/setup` on the server to register the app with GitHub; GitHub returns the app id, private
   key and webhook secret to put in the environment.
3. Install the app on repositories. Per-repository behavior comes from `.github/autoremediator.yml`
   in each repository: `dryRun`, `runTests`, `minimumSeverity`, `allowMajorBumps`,
   `denyPackages`, `allowPackages`, `constraints`, `patchConfidenceThresholds`,
   `dispositionPolicy`, `containmentMode`, `escalationGraph`, and a relative `cwd`.

Webhooks are verified with HMAC; work is queued and retried. Remediation is off by default
(`AUTOREMEDIATOR_GITHUB_APP_ENABLE_DEFAULT_REMEDIATION=false`).
