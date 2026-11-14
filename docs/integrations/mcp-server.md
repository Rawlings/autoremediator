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
| Inspect | `checkReachability`, `evaluatePackage`, `scanDelta`, `toVex` |
| Patches | `listPatchArtifacts`, `inspectPatchArtifact`, `validatePatchArtifact` |
| Jobs | `submitRemediateJob`, `submitScanJob`, `submitPortfolioJob`, `pollJob` |
| Server | `health` |

Use the job tools for long runs: submit, then poll with the returned `jobId`.

## Trust

The server runs with the permissions of its process and the project directories it is pointed at.
Callers cannot set `changeRequest.tokenEnvVar` or `changeRequest.githubApiUrl`; credentials come
from the server's environment. Start with `planRemediation`, which never writes. See
[Safety](../safety.md#trust-boundaries).
