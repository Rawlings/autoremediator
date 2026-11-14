---
"autoremediator": minor
---

MCP tools are now generated from a single operation catalog, and option schemas come from one zod
definition (`platform/option-schemas.ts`) that also validates input.

- Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) and a title.
- **Breaking:** tool arguments are validated strictly. Unknown fields and wrong types are returned
  as error results naming the field; before, they were silently ignored. This removes
  `kevMandatory` and `epssThreshold` from the MCP and HTTP schemas: they were advertised but only
  the CLI ever applied them. Use `exploitSignalOverride` (`{ kev: { mandatory }, epss: { mandatory,
  threshold } }`), which is now exposed, as are `typecheck`, `supplyChainPolicy` and
  `reproductionTest`. The CLI flags are unchanged.
- **Breaking:** callers can no longer pass change-request credentials (`token`, `tokenEnvVar`,
  `githubApiUrl`) over MCP; such calls are rejected instead of being stripped.
- Portfolio targets accept `format`, `audit` and `riskHint` everywhere (campaign mode can now be
  driven over MCP), and `evaluatePackage` accepts `cwd` so it uses the project's `.npmrc`.
- The policy file's `escalationGraph` rejects unknown unresolved reasons instead of accepting any key.
