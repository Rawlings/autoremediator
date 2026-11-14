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
| public | `GET /health`, `GET /openapi.json` |
| reader | `GET /jobs/:id`, `POST /vex`, `POST /reachability`, `POST /packages/evaluate`, `POST /delta-scan`, `POST /patches/list`, `/patches/inspect`, `/patches/validate` |
| operator | `POST /plan-remediation` |
| admin | `POST /remediate`, `/remediate-from-scan`, `/remediate-portfolio`, `/update-outdated`, `/patches/reconcile`, `/jobs/remediate`, `/jobs/scan`, `/jobs/portfolio` |

Routes, request bodies and the OpenAPI document are generated from the same operation catalog as the
[MCP tools](mcp-server.md), so they cannot drift. A body holds the operation's main argument at the
top level (`cveId`, `inputPath`, `targets`, `patchFilePath`, `packageName`, `report`) and every SDK
option under `options`. Unknown fields, at either level, are rejected with `400`. A role comes from
the operation's annotations: read-only operations need `reader`, previews `operator`, anything that
can change the project `admin`. Roles are cumulative: `admin` can call everything. Jobs are held in
memory; they are lost on restart and old finished jobs expire.

## Authentication

Authentication is required. Configure either or both:

- `AUTOREMEDIATOR_API_TOKENS="role:token,role:token"`: static bearer tokens.
- `AUTOREMEDIATOR_JWT_SECRET`: HMAC-SHA256 JWTs with a `role` claim.

With neither, every route except health and the spec returns `503`.
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
