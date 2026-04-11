# Contributing to Autoremediator

Thanks for contributing.

This project uses a docs-first structure where product and usage documentation lives under packages/docs, while governance and execution rules remain in .github/instructions and .github/skills.

## Quick Start

Prerequisites:

- Node.js 18+
- pnpm (recommended)
- Git
- OpenAI or Anthropic API key for live model runs

Clone and install:

```bash
git clone https://github.com/rawlings/autoremediator.git
cd autoremediator
pnpm install
```

Build and validate:

```bash
pnpm build
pnpm typecheck
pnpm test
```

npm/yarn alternatives are supported, but pnpm is the preferred contributor workflow.

## Code Layout (Current)

Runtime source currently lives under packages/core/src with feature-first modules:

- packages/core/src/platform
- packages/core/src/intelligence
- packages/core/src/scanner
- packages/core/src/remediation
- packages/core/src/mcp
- packages/core/src/openapi
- packages/core/src/api/
- packages/core/src/cli/

## Documentation Layout

- Root README.md is intentionally high-level.
- Detailed docs are under packages/docs:
  - getting-started.md
  - cli.md
  - scanner-inputs.md
  - policy-and-safety.md
  - api-sdk.md
  - integrations.md
  - contributor-guide.md

## Governance Expectations

Before opening a PR that changes runtime behavior, update matching governance docs:

- .github/instructions/tool-contracts.instructions.md
- .github/instructions/orchestration.instructions.md
- .github/instructions/feature-completeness-gate.instructions.md
- .github/instructions/documentation-governance.instructions.md
- .github/instructions/testing.instructions.md
- relevant skill files under .github/skills

For public API naming and schema changes, include .github/skills/public-api-governance/SKILL.md in the update set and keep canonical terms aligned across SDK, CLI mapping, MCP, OpenAPI, and docs.

If you change public API or CLI behavior, update documentation in packages/docs and ensure root README links remain correct.

If you add or modify patch lifecycle operations (`listPatchArtifacts`, `inspectPatchArtifact`, `validatePatchArtifact`), keep SDK, CLI, MCP, OpenAPI, and docs aligned in one change set.

## Default Feature Workflow

Feature work should follow this default path:

1. Use `.github/skills/feature-implementation/SKILL.md` to classify feature scope.
2. Use `.github/skills/test-governance/SKILL.md` to determine required test updates.
3. Apply docs/governance mappings from `.github/instructions/documentation-governance.instructions.md`.
4. Validate governance consistency with `.github/skills/governance-check/SKILL.md`.

This process is advisory-first by default (warn-first), but still required for completeness.

## Pull Request Checklist

- Build passes
- Typecheck passes
- Tests pass (unless the change is docs-only)
- Docs updated for any user-facing or contributor-facing behavior change
- Governance instructions and skills updated when execution behavior changes
- Feature category identified (`internal-tool`, `public-operation`, or `bugfix-refactor`)
- Mandatory update bundle completed per `.github/instructions/feature-completeness-gate.instructions.md`
