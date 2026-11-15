---
"autoremediator": minor
"@autoremediator/github-app": minor
"autoremediator-rawlings": patch
---

Agentic remediation, a security hardening pass, and a reorganized source tree.

**Positioning.** The package, CLI, OpenAPI, GitHub Action, VS Code extension and Claude Code plugin are now described around one loop: plan the fix, repair what an upgrade breaks, verify it independently, roll back on failure. The README is rewritten around it, and the CLI text output lists each package's outcome before the totals. JSON, SARIF and VEX output are unchanged.

**Security hardening.** The tool now assumes the project it works on is not fully trusted.

- Child processes no longer inherit credentials, and dependency install scripts are skipped by default (`installScripts: all` in the policy file restores them).
- Remote callers (MCP, HTTP, A2A) pass file paths, not inline scripts or policies, and the operations that run a project's installs and tests need the `admin` role.
- The repair agent can edit fewer files, and a verified change is checked again before it is applied; saved proof-of-fix scripts always run in the sandbox.
- Recipes a dependency ships for itself are no longer read automatically, and the GitHub App keeps its installation token out of the clone URL.
- The VS Code extension runs the release it was built with instead of downloading the newest one, and declares that it does not support untrusted workspaces.

**Reorganized source.** The code now lives in feature folders with one dependency direction, and shared helpers (typed errors, schema-checked JSON reading) are in one place. Commands, SDK exports and the MCP, HTTP and A2A contracts are unchanged. The built files moved: the CLI, MCP server and HTTP server are now under `dist/surfaces/`, and the trace hook is under `dist/features/trace/`. The `autoremediator` and `autoremediator-mcp` commands and the `autoremediator/cli`, `/mcp`, `/openapi` and `/trace` subpaths still work.

**Breaking.** Remote integrations that sent inline scripts or policies, or used an `operator` token for operations that now need `admin`, must change. Anything that started a server or hook by its old `dist/` file path must use the new path or the package subpath.
