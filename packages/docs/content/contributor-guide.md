# Contributor Guide

## Documentation Split

- root `README.md`: high-level product entry
- `packages/docs/*`: detailed usage and integration docs
- `.github/instructions/*`: governance instructions
- `.github/skills/*`: skill-level guidance

## Current Runtime Layout

Runtime source currently lives in `packages/core/src` with feature-first modules.

## Contributor Workflow

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Use pnpm-first commands in docs and examples unless compatibility context requires alternatives.
