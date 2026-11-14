---
"autoremediator": minor
---

A2A (Agent2Agent) agent card, so other agents can discover and delegate to Autoremediator.

- **`GET /.well-known/agent-card.json`** on the HTTP server: a public Agent Card (A2A protocol 1.0)
  with skills generated from the operation catalog (`remediate`, `planRemediation`,
  `remediateFromScan`, `guardPackage`, `evaluatePackage`, `scanDelta`, `checkReachability`,
  `verifyRun`, `getRun`, `listRuns`, `toVex`), a bearer security scheme matching the server's
  authentication, and every unsupported capability (streaming, push notifications, extended card)
  declared `false`.
- **`POST /a2a`**: a JSON-RPC endpoint implementing `SendMessage` and `GetTask`. A message with a data
  part `{"operation", "input"}` runs the skill and returns a task with the result as a JSON artifact.
  It uses the HTTP API's bearer tokens, the role of the operation, and the same path confinement.
- **Signed card**: set `AUTOREMEDIATOR_A2A_SIGNING_KEY` to a PEM EC or Ed25519 private key and the card
  carries a JWS signature (JCS-canonicalized, RFC 7515/8785). `AUTOREMEDIATOR_A2A_BASE_URL` sets the
  URL the card advertises behind a TLS proxy.
- New page `docs/integrations/a2a.md` with the specification sources and the readings taken where the
  specification is ambiguous.
