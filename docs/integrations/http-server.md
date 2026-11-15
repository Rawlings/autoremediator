# HTTP server

An HTTP API for the same operations as the [SDK](../reference/sdk.md), described by an OpenAPI
document at `GET /openapi.json`.

```bash
AUTOREMEDIATOR_API_TOKENS="admin:s3cret" \
  node node_modules/autoremediator/dist/openapi/server.js --port 3000
```

It listens on `127.0.0.1` over plain HTTP. If you expose it, terminate TLS in a reverse proxy.

## Routes

| Role | Routes |
| ---- | ------ |
| public | `GET /health`, `GET /openapi.json`, `GET /.well-known/agent-card.json` |
| reader | `POST /patches/list`, `POST /patches/inspect`, `POST /patches/validate`, `POST /runs/get`, `POST /runs/list`, `POST /vex`, `GET /jobs/:jobId`, `POST /reachability`, `POST /packages/evaluate`, `POST /packages/guard`, `POST /autonomy`, `POST /packages/diet`, `POST /delta-scan`, `POST /recipes/list`, `POST /packages/assess-upgrade`, `POST /packages/vulnerable-symbols`, `POST /policy/explain`, `POST /maintainer-vex`, `POST /freshness`, `POST /memory/list` |
| operator | `POST /plan-remediation`, `POST /attempts/abandon`, `POST /incident`, `POST /premortem`, `POST /policy/compile`, `POST /proof-of-fix/generate`, `POST /radar`, `POST /freshness/plan` |
| admin | `POST /remediate`, `POST /remediate-from-scan`, `POST /remediate-portfolio`, `POST /patches/reconcile`, `POST /runs/apply`, `POST /runs/resume`, `POST /runs/rollback`, `POST /runs/verify`, `POST /attempts/start`, `POST /attempts/patch`, `POST /attempts/verify`, `POST /attempts/recipe`, `POST /attempts/finalize`, `POST /update-outdated`, `POST /jobs/remediate`, `POST /jobs/scan`, `POST /jobs/portfolio`, `POST /evidence-pack` |

`POST /a2a` is the [A2A](a2a.md) JSON-RPC endpoint (`SendMessage`, `GetTask`). It needs a valid bearer token, then the role of the operation named in the message.

Routes, request bodies and the OpenAPI document are generated from the same operation catalog as the
[MCP tools](mcp-server.md), so they cannot drift. A body holds the operation's main argument at the
top level (`cveId`, `inputPath`, `targets`, `patchFilePath`, `packageName`, `report`) and every SDK
option under `options`. Unknown fields, at either level, are rejected with `400`. A role comes from
the operation's annotations: read-only operations need `reader`, previews `operator`, anything that
can change the project or run its code `admin`. Verifying a run, starting an attempt, proposing a patch
and applying a recipe run the project's installs and tests (or edit files that get run), and that code
sees every secret the server holds, so they are `admin` too. Roles are cumulative: `admin` can call
everything.

Remote callers pass paths, never content: `options.reproductionTest` must be the path of an existing
file inside the allowed roots, and `options.policy` must be the path of a policy file. Inline scripts
and inline YAML or JSON policies are refused with `403`; the SDK and the command line still accept
them. Jobs are held in
memory; they are lost on restart and old finished jobs expire.

## Authentication

Authentication is required. Configure either or both:

- `AUTOREMEDIATOR_API_TOKENS="role:token,role:token"`: static bearer tokens.
- `AUTOREMEDIATOR_JWT_SECRET`: HMAC-SHA256 JWTs with a `role` claim.

With neither, every route except health, the spec and the agent card returns `503`.
`AUTOREMEDIATOR_INSECURE_NO_AUTH=1` disables the requirement, for local development only.

## Request limits

- `POST` bodies must be `application/json` and at most 1 MiB (`AUTOREMEDIATOR_MAX_BODY_BYTES`).
- The `Host` header must be `127.0.0.1`, `localhost` or `[::1]` (`AUTOREMEDIATOR_ALLOWED_HOSTS` to
  add more), which blocks DNS rebinding.
- Path options (`cwd`, `inputPath`, `patchesDir`, `policy`, `patchFilePath`, ...; the OpenAPI schema
  marks them `x-path`) must resolve, after following symlinks, inside the server's working
  directory. `AUTOREMEDIATOR_ALLOWED_ROOTS` replaces that default. Anything outside gets `403`.
- Change-request credentials and endpoints (`token`, `tokenEnvVar`, `githubApiUrl`) are not accepted
  from callers; such a request gets `400`.

Variables are listed in [Environment variables](../reference/environment.md#http-server). The
reasoning behind these limits is in [Safety](../safety.md#trust-boundaries).
