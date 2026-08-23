# @autoremediator/github-app

## 0.1.2

### Patch Changes

- 4fece5d: - **Dependency Modernization & Consolidation (2026 Standards)**:
  - Removed dead/unused `chalk` runtime dependency from `autoremediator` core.
  - Removed redundant `@octokit/rest` monolithic SDK from `autoremediator` core in favor of native `httpClient` (`fetch`), eliminating significant bundle weight.
  - Replaced legacy `tocbot` in documentation app (`docs`) with a pure declarative React 19 TOC component using `IntersectionObserver`.
  - Adopted Pnpm 10 Catalogs (`catalog:`) across workspace packages for unified toolchain versioning (`typescript`, `@types/node`, `vitest`, `tsup`, `yaml`).
- Updated dependencies [4fece5d]
- Updated dependencies [4fece5d]
  - autoremediator@0.17.0

## 0.1.1

### Patch Changes

- 8904cda: Dependency updates.
- Updated dependencies [afef1de]
- Updated dependencies [8904cda]
  - autoremediator@0.16.0
