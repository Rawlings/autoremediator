---
"autoremediator": patch
"docs": patch
"@autoremediator/github-app": patch
"autoremediator-rawlings": patch
---

- **Dependency Modernization & Consolidation (2026 Standards)**:
  - Removed dead/unused `chalk` runtime dependency from `autoremediator` core.
  - Removed redundant `@octokit/rest` monolithic SDK from `autoremediator` core in favor of native `httpClient` (`fetch`), eliminating significant bundle weight.
  - Replaced legacy `tocbot` in documentation app (`docs`) with a pure declarative React 19 TOC component using `IntersectionObserver`.
  - Adopted Pnpm 10 Catalogs (`catalog:`) across workspace packages for unified toolchain versioning (`typescript`, `@types/node`, `vitest`, `tsup`, `yaml`).
