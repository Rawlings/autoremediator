# MCP server

`autoremediator-mcp` exposes Autoremediator to MCP clients such as editors and agents: tools, resources and prompts, over stdio or [HTTP](#over-http).

```json
{
  "mcpServers": {
    "autoremediator": {
      "command": "npx",
      "args": ["-y", "-p", "autoremediator", "autoremediator-mcp"]
    }
  }
}
```

## Tools

Tool names match the [SDK functions](../reference/sdk.md#functions), and arguments match the SDK
options. Tools that return a report return it as JSON.

| Group | Tools |
| ----- | ----- |
| Remediate | `remediate`, `planRemediation`, `remediateFromScan`, `remediatePortfolio`, `updateOutdated` |
| Runs | `applyPlan`, `verifyRun`, `resumeRun`, `rollbackRun`, `getRun`, `listRuns` (see [Plan, apply and roll back](../guides/plan-and-apply.md)) |
| Attempts | `startAttempt`, `proposePatch`, `verifyAttempt`, `finalizeAttempt`, `abandonAttempt` (see [Letting your agent do the repair](../guides/plan-and-apply.md#letting-your-own-agent-do-the-repair)) |
| Inspect | `checkReachability`, `evaluatePackage`, `guardPackage` ([details](../guides/guard.md)), `assessUpgrade`, `findVulnerableSymbols` ([details](../guides/upgrade-impact.md)), `analyzeDependencies` ([details](../guides/dependency-diet.md)), `incident`, `premortem` ([details](../guides/incident-response.md)), `getAutonomy` ([details](../guides/earned-autonomy.md)), `scanDelta`, `toVex` |
| Recipes | `listRecipes`, `applyRecipe` ([details](../guides/recipes.md)) |
| Evidence | `buildEvidencePack` ([details](../guides/evidence-pack.md)), `generateProofOfFix` ([details](../guides/proof-of-fix-generation.md)), `readMaintainerVex` ([details](../guides/maintainer-vex.md)) |
| Advice | `radar` ([details](../guides/silent-fix-radar.md)), `freshnessReport`, `planFreshnessStep` ([details](../guides/freshness.md)), `listMemory` ([details](../guides/memory.md)), `compilePolicy`, `explainPolicy` ([details](../guides/policy-in-plain-language.md)) |
| Patches | `listPatchArtifacts`, `inspectPatchArtifact`, `validatePatchArtifact`, `reconcilePatchArtifacts` |
| Jobs | `submitRemediateJob`, `submitScanJob`, `submitPortfolioJob`, `pollJob` |
| Server | `health` |

Use the job tools for long runs: submit, then poll with the returned `jobId`.

A host agent that should review before changing anything calls `planRemediation`, shows the plan,
then `applyPlan` with the returned `runId`; `rollbackRun` undoes it.

Tools are generated from one operation catalog (`packages/core/src/catalog`), so their schemas are the
same ones that validate input. Each tool carries MCP annotations: `readOnlyHint` for tools that change
nothing, `destructiveHint` for tools that edit the project unless `dryRun` is set, and `openWorldHint`
for tools that call external services. Arguments are validated strictly: an unknown field or a value
of the wrong type is returned as an error result naming the field, instead of being ignored.

### Results

Every tool declares an `outputSchema` and returns `structuredContent`, so a host can use the result
without parsing text; the text content carries the same JSON. A tool that returns a list returns it
as `{ "items": [...] }` in `structuredContent`. A failed call is an error result with a message and no
structured content.

## Resources

Read-only documents, so a host can look at a run without a tool call:

| URI | Content |
| --- | ------- |
| `autoremediator://runs` | Recorded runs, newest first |
| `autoremediator://runs/{runId}` | The run: record, plan, item outcomes, attempts, ledger check |
| `autoremediator://runs/{runId}/plan` | The plan |
| `autoremediator://runs/{runId}/steps` | The hash-chained ledger |
| `autoremediator://runs/{runId}/attempts/{attemptId}/diff` | The patch an attempt produced |
| `autoremediator://runs/{runId}/attempts/{attemptId}/verification` | What the verifier made of it |
| `autoremediator://runs/{runId}/attempts/{attemptId}/transcript` | What the agent said and did |
| `autoremediator://policy` | The project's `.github/autoremediator.yml` |

Ids are validated before they reach the filesystem; anything else is an unknown resource. The project
is the client's first declared root, else the server's working directory.

## Prompts

`remediate-cve`, `repair-upgrade` and `review-run` walk a host through the safe order with these
tools: plan, show me, apply, verify, offer rollback; or fix an upgrade that breaks the project in an
isolated checkout; or review what a run did.

## Confirming changes

Hosts normally ask before calling a tool annotated as destructive. To have the server ask itself,
through MCP elicitation, before any tool that changes the project, set
`AUTOREMEDIATOR_MCP_CONFIRM=mutating`. A client that cannot be asked is refused rather than trusted,
so use it with clients that support elicitation. Over HTTP the role check is the gate instead.

## Over HTTP

```bash
AUTOREMEDIATOR_API_TOKENS="reader:r,operator:o,admin:a" autoremediator-mcp --http --port 3001
```

Streamable HTTP at `POST http://127.0.0.1:3001/mcp`, stateless: every request stands alone, there are
no sessions, and nothing carries over. It listens on loopback only, checks the `Host` header, and
uses the same bearer tokens and roles as the [HTTP API](http-server.md#authentication). Reading
(`tools/list`, resources, prompts, read-only tools) needs `reader`; each tool needs the role its
annotations imply: planning and analysis tools `operator`, tools that can change the project or run
its code (installs, tests, a reproduction script: `verifyRun`, `startAttempt`, `proposePatch`,
`verifyAttempt`, `applyRecipe`) `admin`. Without tokens configured every request is refused, unless
`AUTOREMEDIATOR_INSECURE_NO_AUTH=1` (local development only). Path arguments are confined as over
stdio. Client roots and elicitation need a session, so they are not available over HTTP.

## Allowed paths

Path arguments (`cwd`, `inputPath`, `patchesDir`, `policy`, `patchFilePath`, ...) must resolve, after
following symlinks, inside an allowed root; anything else comes back as an error result. The allowed
roots are the server's working directory plus any roots the client declares through MCP `roots`.
Set `AUTOREMEDIATOR_ALLOWED_ROOTS` (comma-separated absolute paths) to replace both. If your host
starts the server from a different directory than your projects and does not declare roots, set that
variable.

## Trust

The server runs with the permissions of its process and the project directories it is pointed at.
Callers cannot set change-request credentials or endpoints (`tokenEnvVar`, `token`, `githubApiUrl`):
such calls are rejected, and credentials come from the server's environment. Start with
`planRemediation`, which changes nothing in the project and writes only its own evidence record. See
[Safety](../safety.md#trust-boundaries).
