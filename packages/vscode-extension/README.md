# Node CVE Remediator (Autoremediator VS Code Extension)

**Autoremediator** is a risk-aware Node.js vulnerability diagnostics and remediation extension for Visual Studio Code. It combines OSV package intelligence with live FIRST EPSS exploit probability scores, CISA KEV exploitation catalogs, and Rust-based AST reachability analysis (`oxc-parser`).

## Features

- 🛡️ **Interactive Security Intelligence Hovers**: Hover over any dependency in `package.json` to view real-time CVSS severity, CISA KEV active exploitation badges, EPSS score percentiles, AST reachability status, and safe upgrade versions.
- ⚡ **1-Click QuickFix Remediation**: Apply version bumps and overrides directly from editor diagnostics and hover action links.
- 🔬 **AST Call-Graph Reachability**: Run `Autoremediator: Check package AST reachability` to verify whether vulnerable functions/exports are actually imported and invoked in your source files.
- 🔍 **Git-Aware Delta Vulnerability Scanning**: Run `Autoremediator: Scan git delta against HEAD` to audit uncommitted working-tree changes without scanning your entire project backlog.
- 📄 **Virtual Patch Diff Previews**: Inspect isolated `.patch` artifacts side-by-side using the `autoremediator-patch://` virtual document provider before committing changes to disk.
- 🏷️ **CodeLens Summary Indicators**: Live summary annotations above `dependencies` sections in `package.json`.

## Requirements

The extension integrates with `autoremediator` CLI installed locally or via `npx -y autoremediator`.

## License

MIT
