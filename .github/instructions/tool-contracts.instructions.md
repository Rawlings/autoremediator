# Tool Contracts

## Canonical Tool Order

1. lookup-cve
2. check-inventory
3. check-version-match
4. find-fixed-version
5. apply-version-bump

Fallback branch (only when version bump cannot be applied):

6. fetch-package-source
7. generate-patch
8. apply-patch-file

## Input/Output Contract Rules

- Every tool must declare zod parameters and typed result fields.
- Tool outputs must be machine-readable and avoid natural language-only status.
- Failure outputs must include a clear error message string.
- `check-inventory`, `apply-version-bump`, and `apply-patch-file` must accept `packageManager` and auto-detect from lockfile when omitted.
- `apply-patch-file` must accept `dryRun` and must not mutate files when `dryRun=true`.
- apply-version-bump must return strategy="none" when no safe upgrade can be applied.
- apply-patch-file must prefer native patch flows for pnpm and yarn (Berry), and use patch-package compatibility mode for npm and yarn v1.
- patch fallback tools must return structured success=false on failure (no thrown-only failures).
- `fetch-package-source` should return source files under `sourceFiles`.
- `generate-patch` should return `patchContent` (or `patches`) that can be passed directly to `apply-patch-file`.

## Precedence and Conflict Rules

- CLI/API explicit options override policy defaults.
- Policy allow/deny package rules override model decisions.
- If confidence is below threshold, patch application must not proceed.
- If both version bump and patch fallback fail, package result must be unresolved with a reason.

## Current Tool Inventory

- lookup-cve
- check-inventory
- check-version-match
- find-fixed-version
- apply-version-bump
- fetch-package-source
- generate-patch
- apply-patch-file

## Compatibility

When adding or renaming tools:

- Update this file.
- Update packages/core/src/remediation/pipeline.ts tool map.
- Update .github/skills/agent-orchestration/SKILL.md.
- Run the `governance-check` skill checklist.
