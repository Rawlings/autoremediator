# A2A (Agent2Agent)

Autoremediator publishes an [A2A](https://a2a-protocol.org/) Agent Card so other agents can discover
it, and answers A2A `SendMessage` and `GetTask` calls on the [HTTP server](http-server.md). An agent
that speaks A2A can delegate "check this package before installing it" or "plan a fix for this CVE"
without knowing the HTTP API.

Implemented against **A2A protocol version 1.0** (specification release 1.0.0), JSON-RPC binding.

## Discovery

```bash
curl http://127.0.0.1:3000/.well-known/agent-card.json
```

The card is public, like `/health` and `/openapi.json`, and holds no secrets: it names the
authentication scheme, never a token. It advertises:

- **One interface**: `{url: <base>/a2a, protocolBinding: "JSONRPC", protocolVersion: "1.0"}`.
- **Capabilities all `false`**: no streaming, no push notifications, no extended card. The card does
  not claim anything the server does not do.
- **A bearer security scheme** (`securitySchemes.bearerAuth`, an `httpAuthSecurityScheme` with
  scheme `Bearer`), the same tokens the HTTP server accepts: a static token from
  `AUTOREMEDIATOR_API_TOKENS` or an HS256 JWT with a role claim.
- **Skills**, generated from the [operation catalog](../reference/sdk.md), so ids, names and
  descriptions cannot drift from what runs.

| Skill id | Role needed |
| -------- | ----------- |
| `guardPackage`, `evaluatePackage`, `scanDelta`, `checkReachability`, `getRun`, `listRuns`, `toVex` | `reader` |
| `planRemediation` | `operator` |
| `verifyRun`, `remediate`, `remediateFromScan` | `admin` (`verifyRun` runs the project's installs and tests) |

The role is part of each skill's description. Attempts, rollback, portfolio runs and jobs stay on the
HTTP API and MCP.

The URL in the card is `AUTOREMEDIATOR_A2A_BASE_URL` when set; otherwise `http://` plus the request's
`Host` header, which must already be an allowed host. The server speaks plain HTTP on loopback: behind
a TLS proxy, set `AUTOREMEDIATOR_A2A_BASE_URL` to the public `https://` address so the card points
there.

The card is built by `buildAgentCard({ baseUrl, version, skills })` in `packages/core/src/a2a/`, a
pure function exported with the rest of that module.

## Delegating a task

`POST /a2a` takes a JSON-RPC 2.0 request with an `Authorization: Bearer` header. A `SendMessage`
message carries one data part naming a skill and its input, which is the operation's input as in the
[MCP tools](mcp-server.md) (flat, not nested under `options`):

```bash
curl -s http://127.0.0.1:3000/a2a \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "A2A-Version: 1.0" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "m-1", "role": "ROLE_USER",
        "parts": [{
          "data": { "operation": "guardPackage", "input": { "spec": "left-pad@1.3.0" } },
          "mediaType": "application/json"
        }]
      }
    }
  }'
```

The reply is `result.task`: a task with `status.state` `TASK_STATE_COMPLETED` and the operation's result
as a JSON data part in `artifacts[0]`, or `TASK_STATE_FAILED` with the error text in `status.message`.
`GetTask` (`{"id": "<task id>"}`) returns the task again.

How it behaves:

- **Synchronous.** The operation runs to completion before the reply, so a task is never in a working
  state. `remediate` can take minutes; for long runs use the HTTP [jobs](http-server.md) instead.
  `returnImmediately` is accepted and has no effect.
- **Same authorization as the HTTP API.** The token must be valid (`401`, or `503` while no tokens are
  configured), then must hold the skill's role (`403`), and path arguments are confined to the allowed
  roots (`403`) exactly as on the HTTP routes. `GetTask` needs the role the task ran with.
- **Tasks are held in memory**: at most 500, for an hour, lost on restart. Messages with a `taskId`
  (continuing a task) are refused with `UnsupportedOperationError`.
- **Errors** are JSON-RPC errors with HTTP 200: `-32602` for an unknown skill, a missing data part or
  invalid input, `-32601` for any method other than `SendMessage` and `GetTask`, `-32009` for an
  `A2A-Version` other than `1.0`, `-32005` when `acceptedOutputModes` excludes `application/json`,
  `-32001` for an unknown task.
- Only `SendMessage` and `GetTask` exist. `SendStreamingMessage`, `ListTasks`, `CancelTask`,
  `SubscribeToTask`, push notification configs and `GetExtendedAgentCard` are not implemented, and the
  HTTP+JSON and gRPC bindings are not offered.

## Signing the card

Set `AUTOREMEDIATOR_A2A_SIGNING_KEY` to the path of a PEM private key and the card is served with a
`signatures` entry, so a client can check it came from whoever holds the key.

```bash
openssl genpkey -algorithm ed25519 -out a2a-card.pem
AUTOREMEDIATOR_A2A_SIGNING_KEY=./a2a-card.pem node dist/openapi/server.js
```

Supported keys: EC P-256, P-384 or P-521 (`ES256`, `ES384`, `ES512`) and Ed25519 (`EdDSA`). The
signature follows A2A section 8.4:

- The payload is the card without `signatures`, canonicalized with JCS (RFC 8785), then base64url.
- The JWS (RFC 7515) signing input is `BASE64URL(protected) || "." || BASE64URL(payload)`. EC
  signatures use the raw `r || s` form JWS requires.
- The protected header is `{"alg": ..., "typ": "JOSE", "kid": ...}`. `kid` is the RFC 7638 JWK
  thumbprint of the public key. No `jku` is emitted and the server hosts no key set: give verifiers
  the public key (or its thumbprint) out of band.
- The card is signed per request, so the signature always matches the advertised URL.

A configured key that cannot be read or is the wrong type makes the card endpoint fail with `500` and
log the reason, rather than serve an unsigned card. Only the signature is published, never the key.

## Specification notes

Field names and shapes come from the A2A 1.0.0 specification and its normative `a2a.proto`. Where the
specification is ambiguous, this is the reading used:

- **`typ` header**: section 8.4.2 lists it both as a MUST and as a SHOULD be `JOSE`. It is always
  emitted as `JOSE`.
- **Skill security requirements**: a `SecurityRequirement` maps a scheme to a list of scopes, but a
  bearer scheme defines no scopes, so roles are described in the skill text instead of encoded as
  scopes. The card has one top-level requirement (`bearerAuth`, no scopes).
- **Missing `A2A-Version` header**: the specification says an empty value means 0.3 and does not say
  what an absent one means. An absent header is accepted as 1.0; any other value is refused.
- **Default-valued fields when signing**: the capability flags are explicitly set to `false`, which
  the specification counts as set and therefore signed. Other default-valued fields are not emitted.

Sources:

- [A2A Protocol Specification, 1.0.0](https://a2a-protocol.org/latest/specification/): section 4.4
  (Agent Card, skills, interfaces, signatures), 4.5 (security schemes), 8.2 and 14.3 (well-known
  location), 8.4 (signing), 9 (JSON-RPC binding), appendix A (changes from 0.3).
- [`a2a.proto`](https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto) in the
  [a2aproject/A2A](https://github.com/a2aproject/A2A) repository (package `lf.a2a.v1`).
- [RFC 7515](https://www.rfc-editor.org/rfc/rfc7515) (JWS), [RFC 7638](https://www.rfc-editor.org/rfc/rfc7638)
  (JWK thumbprint), [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS).

The MCP HTTP server does not serve the card: it has no A2A endpoint for the card to point at.
