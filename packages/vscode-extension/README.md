# Autoremediator for VS Code

Autoremediator is a risk-aware Node.js vulnerability diagnostics and remediation extension for Visual Studio Code. It combines OSV package intelligence with FIRST EPSS exploit probability scores, CISA KEV exploitation signals, and AST reachability analysis.

## Features

- **Security Intelligence Hovers** — hover over dependencies in `package.json` to view CVSS severity, CISA KEV exploitation status, EPSS score percentiles, AST reachability, and safe upgrade versions.
- **QuickFix Remediation** — apply version bumps and dependency overrides directly from editor diagnostics and hover actions.
- **AST Reachability Analysis** — verify whether vulnerable package exports are actually imported and invoked in source files.
- **Git Delta Scanning** — audit uncommitted working-tree changes without scanning the entire project.
- **Virtual Patch Previews** — inspect `.patch` artifacts side-by-side using the `autoremediator-patch://` document provider before applying changes.
- **CodeLens Summaries** — view vulnerability annotations directly above dependency declarations in `package.json`.

## Requirements

The extension requires Node.js 22+ and integrates with the `autoremediator` CLI (installed locally or run via `npx autoremediator`).

## License

MIT
