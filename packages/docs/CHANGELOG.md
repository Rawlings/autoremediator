# docs

## 0.0.1

### Patch Changes

- afef1de: ### Features & Security Hardening

  - **AST Call-Graph Reachability Engine (Pillar 3.1)**: Integrated the Rust-based `oxc-parser` to perform high-performance AST-level reachability analysis across ECMAScript and TypeScript sources. Supports static imports, dynamic `import()`, CommonJS `require()`, and re-exports. Added call-graph invocation tracing (`traceSymbolInvocations`) to prune uncalled symbols and dead code paths, automatically generating CycloneDX 1.5 VEX statements with `status: "not_affected"` and `justification: "code_not_in_execute_path"`. Added `tsconfig.json` and `jsconfig.json` path-alias resolution (`compilerOptions.paths` and `baseUrl`).
  - **Node.js Package Manager Driver Architecture**: Added modular driver framework in `platform/package-manager/driver.ts` with dedicated driver implementations for `npm`, `pnpm`, `yarn`, `bun`, and `deno` (managing lockfile formats, CLI commands, deterministic installation flags, and monorepo workspace filters).
  - **Subprocess Execution Sandboxing & Environment Scrubbing**: Created `platform/safe-exec.ts` (`safeExeca`) to sanitize process environments against process-injection supply-chain attacks (stripping dangerous variables like `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `PERL5OPT`), enforce execution timeouts, and isolate process spawns.
  - **Patch Syntax Pre-Validation Gate**: Implemented pre-validation gate in `remediation/tools/generate-patch/helpers.ts` verifying AST syntax for JavaScript/TypeScript (`oxc-parser`), JSON (`JSON.parse`), and YAML (`yaml.parse`) before writing diffs or applying patches to disk.
  - **Enterprise SIEM Structured Audit Logging & JWT RBAC**: Implemented RFC 3339 / Common Event Format (CEF) structured audit logging in `platform/audit-logger.ts`. Added HMAC-SHA256 JWT token signature verification and role-based access control (`reader`, `operator`, `admin`) with timing-safe comparisons in `openapi/rbac.ts`.
  - **Git-Aware Dynamic Atomic Rollback**: Created `platform/rollback.ts` with dynamic workspace manifest discovery, Git transaction preservation (`git status --porcelain=v1 -uall`), and active file-touch recording (`recordFileTouch`) to guarantee complete restoration of modified or created files upon remediation failure.

- 8904cda: Dependency updates.
