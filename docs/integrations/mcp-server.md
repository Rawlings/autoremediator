# MCP server

`autoremediator-mcp` exposes Autoremediator to MCP clients such as editors and agents, over stdio.

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
| Inspect | `checkReachability`, `evaluatePackage`, `scanDelta`, `toVex` |
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
