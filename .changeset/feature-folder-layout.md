---
"autoremediator": minor
---

Reorganize the source into feature folders and move the built entry points. The command-line names, the SDK exports and the MCP, HTTP and A2A contracts are unchanged. What changes is where the built files live, which matters only if you started a server or hook by its file path.

- The built CLI, MCP server and HTTP server moved to `dist/surfaces/cli/index.js`, `dist/surfaces/mcp/server.js` and `dist/surfaces/openapi/server.js`; the trace hook moved to `dist/features/trace/register.js`. The `autoremediator` and `autoremediator-mcp` commands and the `autoremediator/cli`, `/mcp`, `/openapi` and `/trace` package subpaths keep working.
- If you ran `node node_modules/autoremediator/dist/openapi/server.js`, use `dist/surfaces/openapi/server.js` or the `autoremediator/openapi` subpath.
- Internals only: typed errors with stable codes, one shared error-message helper, and JSON parsing against a schema at the file boundary now exist in `shared/`.
