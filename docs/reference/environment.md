# Environment variables

## Core

| Variable | Purpose |
| -------- | ------- |
| `AUTOREMEDIATOR_MODEL` | Default `--model` for the [patch fallback](../guides/patch-generation.md) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ... | Read by the model provider package, not by Autoremediator |
| `AUTOREMEDIATOR_NVD_API_KEY` | NVD API key for higher rate limits |
| `GITHUB_TOKEN` | Raises GitHub Advisory Database rate limits; opens [pull requests](../guides/automation.md#pull-requests) |
| `GH_TOKEN` | Fallback for opening pull requests |
| `AUTOREMEDIATOR_EPSS_API` | Alternative EPSS endpoint |
| `AUTOREMEDIATOR_TRACE_FILE`, `AUTOREMEDIATOR_TRACE_PACKAGES`, `AUTOREMEDIATOR_TRACE_CALLS` | Used by the [trace hook](../guides/runtime-reachability.md): JSONL output path (the hook does nothing without it), packages to count calls for, `1` to count calls |
| `AUTOREMEDIATOR_EVIDENCE_SIGNING_KEY` | Path to a PEM key used to sign [evidence pack](../guides/evidence-pack.md) attestations (CLI and SDK only, never over MCP or HTTP) |
| `AUTOREMEDIATOR_SKIP_HOOKS` | `1` makes the [git hooks](../guides/git-hooks.md) do nothing |
| `AUTOREMEDIATOR_HOOK_TIMEOUT` | Seconds a git hook may run (default 60 for pre-push, 30 for post-merge) |

## HTTP server

See [HTTP server](../integrations/http-server.md) for how these interact.

| Variable | Purpose |
| -------- | ------- |
| `AUTOREMEDIATOR_API_TOKENS` | `role:token,...` static bearer tokens |
| `AUTOREMEDIATOR_JWT_SECRET` | HMAC secret for JWTs carrying a `role` claim |
| `AUTOREMEDIATOR_INSECURE_NO_AUTH` | `1` disables authentication. Local development only |
| `AUTOREMEDIATOR_MAX_BODY_BYTES` | Request body limit. Default 1 MiB |
| `AUTOREMEDIATOR_ALLOWED_HOSTS` | Extra accepted `Host` values |
| `AUTOREMEDIATOR_ALLOWED_ROOTS` | Extra directories request paths may point into |
| `AUTOREMEDIATOR_A2A_BASE_URL` | Public URL the [A2A](../integrations/a2a.md) Agent Card advertises. Default: `http://` plus the request's `Host` |
| `AUTOREMEDIATOR_A2A_SIGNING_KEY` | Path to a PEM private key (EC P-256/384/521 or Ed25519). When set, the Agent Card is served signed |

## MCP server

| Variable | Purpose |
| -------- | ------- |
| `AUTOREMEDIATOR_MCP_CONFIRM` | `mutating`: ask the user, through the client, before a tool that changes the project (stdio, clients with elicitation). Default off |
| `AUTOREMEDIATOR_MCP_PORT` | Port for `autoremediator-mcp --http` (also `--port`, then `PORT`). Default 3001 |
| `AUTOREMEDIATOR_ALLOWED_ROOTS` | Directories path arguments may point into (replaces the working directory and client roots) |

Over `--http` the HTTP server variables above (`AUTOREMEDIATOR_API_TOKENS`, `AUTOREMEDIATOR_JWT_SECRET`,
`AUTOREMEDIATOR_INSECURE_NO_AUTH`, `AUTOREMEDIATOR_ALLOWED_HOSTS`, `AUTOREMEDIATOR_MAX_BODY_BYTES`) apply.

## GitHub App

The `AUTOREMEDIATOR_GITHUB_APP_*` variables are documented in
[GitHub App](../integrations/github-app.md#configuration) and annotated in
[`.env.example`](../../.env.example).
