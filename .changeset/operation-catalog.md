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
- HTTP routes, request mapping, access roles and the OpenAPI document are generated from the same
  catalog. New routes: `POST /reachability`, `/packages/evaluate`, `/delta-scan`,
  `/patches/reconcile` (and an MCP `reconcilePatchArtifacts` tool). **Breaking:** unknown body fields
  now return `400`, so `planRemediation` no longer accepts `dryRun`/`preview` (a plan is always a
  preview), and option fields must sit under `options`.
- **Breaking:** MCP path arguments are confined to allowed roots (the server's working directory plus
  roots declared by the client, or `AUTOREMEDIATOR_ALLOWED_ROOTS`), as HTTP already was. The guard now
  reads path fields from the schemas (`x-path`), so a new path option is covered when it is declared.
- CLI: `portfolio` and `update-outdated` accepted flags such as `--proof-of-fix`, `--typecheck`,
  `--model` and `--offline` and silently dropped them; all commands now build their SDK options in one
  place. New flag `--reproduction-test <path>`. A test fails when a schema option has no CLI decision.

