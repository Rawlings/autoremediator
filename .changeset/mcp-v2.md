---
"autoremediator": minor
---

MCP v2: structured results, resources, prompts, host-driven attempts and MCP over HTTP.

- Every tool declares an `outputSchema` and returns `structuredContent` (list results as
  `{ items }`); the text content is unchanged.
- **Host-driven attempts.** An agent you already use can do the repair that the built-in agent does:
  `startAttempt` opens an isolated checkout with the upgrade applied and reports what the verifier
  found wrong; edit there, or send a diff with `proposePatch` (project source only, plain text,
  must apply cleanly); `verifyAttempt` runs the same verifier; `finalizeAttempt` applies a verified
  change through the same promotion step; `abandonAttempt` discards it. Available on the SDK, MCP and
  HTTP (`/attempts/*`). Attempts outlive the process that started them (at most four open per run).
- **Resources** (`autoremediator://runs/...`, `.../plan`, `.../steps`, attempt `diff`,
  `verification` and `transcript`, and `autoremediator://policy`) and **prompts**
  (`remediate-cve`, `repair-upgrade`, `review-run`).
- **MCP over HTTP:** `autoremediator-mcp --http [--port]`, stateless streamable HTTP on loopback,
  with the HTTP API's bearer tokens and host check; each tool needs the role its annotations imply.
- `AUTOREMEDIATOR_MCP_CONFIRM=mutating` makes the server ask the user (MCP elicitation) before a
  tool that changes the project; a client that cannot be asked is refused.
- HTTP auth, host checking and body reading moved into `platform/` so both HTTP servers share them;
  the HTTP API's behaviour is unchanged.
