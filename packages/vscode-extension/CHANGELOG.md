# autoremediator-rawlings

## 0.2.0

### Minor Changes

- 4fece5d: - **Interactive DevEx & Pre-Flight Package Vetting (`evaluatePackage`)**: Added pre-installation package security vetting querying OSV, CISA KEV active exploitation, FIRST EPSS score percentiles, and npm registry versions. Exposed via SDK `evaluatePackage`, MCP tool `evaluatePackage`, and CLI `autoremediator evaluate <pkg>`.
  - **AST Call-Graph Reachability Tool (`checkReachability`)**: Standalone AST call-graph reachability exploration via `oxc-parser`. Scans project source files for static imports, dynamic `import()`, `require()`, and re-exports to verify whether vulnerable symbols are actually invoked. Exposed via SDK `checkReachability`, MCP tool `checkReachability`, and CLI `autoremediator reachability --package <name> [--symbol <sym>]`.
  - **Git-Aware Delta Vulnerability Scanner (`scanDelta`)**: Analyzes git diffs (working tree vs `HEAD`, or branch vs base ref) to surface only newly introduced or resolved CVEs during in-flight development or PR code reviews. Exposed via SDK `scanDelta`, MCP tool `scanDelta`, and CLI `autoremediator diff [--base <ref>]`.
  - **Diff-First MCP Protocol & Unified Diffs**: Attached syntax-highlighted `unifiedDiff` strings to `SimulationMutation` and `ResultSimulation` to enable rich interactive code previews in MCP chat hosts (VS Code GitHub Copilot, Roo Code, Cline) before modifying disk.
  - **VS Code Extension Modernization**: Added rich HoverProvider with exploit telemetry cards, CodeLens summary annotations in `package.json`, virtual patch side-by-side diff previews (`autoremediator-patch://`), and debounced in-memory caching.

### Patch Changes

- 4fece5d: - **Dependency Modernization & Consolidation (2026 Standards)**:
  - Removed dead/unused `chalk` runtime dependency from `autoremediator` core.
  - Removed redundant `@octokit/rest` monolithic SDK from `autoremediator` core in favor of native `httpClient` (`fetch`), eliminating significant bundle weight.
  - Replaced legacy `tocbot` in documentation app (`docs`) with a pure declarative React 19 TOC component using `IntersectionObserver`.
  - Adopted Pnpm 10 Catalogs (`catalog:`) across workspace packages for unified toolchain versioning (`typescript`, `@types/node`, `vitest`, `tsup`, `yaml`).

## 0.1.1

### Patch Changes

- 8904cda: Dependency updates.
