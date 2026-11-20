# Contributing

Bug reports, fixes and documentation improvements are welcome. For anything larger than a fix,
open an issue first so we can agree on the approach.

## Set up

You need Node.js 26 or later and pnpm 12 (pinned in `package.json`).

```bash
git clone https://github.com/Diffra/autoremediator.git
cd autoremediator
pnpm install
```

The repository is a pnpm workspace:

| Package | Path |
| ------- | ---- |
| `autoremediator`: CLI, SDK, MCP and HTTP servers | `packages/core` |
| `@autoremediator/github-app` | `packages/github-app` |
| `autoremediator-rawlings`: VS Code extension | `packages/vscode-extension` |

## Before you open a pull request

CI runs these; run them locally first.

```bash
pnpm format:check
pnpm lint
pnpm build:all
pnpm typecheck:all
pnpm test:all
```

Every package's `tsconfig.json` extends the shared `tsconfig.base.json` at the repo root, so strictness
flags live in one place. Lint runs type-aware (`.oxlintrc.json`), so build first: it resolves
`autoremediator` through `packages/core/dist`. Warnings fail lint; fix them or justify an inline disable.

`pnpm format` and `pnpm lint:fix` apply fixes. Tests live next to the code, must not use the
network, and should mock at module boundaries.

## Pull requests

- Keep them focused, and explain what changed and why.
- Add a changeset for any change users can see: `pnpm changeset`. Pick the bump (`patch`, `minor` or
  `major`) and describe the change for a reader of the release notes. Never edit `CHANGELOG.md` by
  hand.
- Update the documentation in the same pull request. [`docs/README.md`](docs/README.md) is the index;
  the change-to-docs mapping is in
  [`documentation-governance.instructions.md`](.github/instructions/documentation-governance.instructions.md).
- Keep names consistent across the SDK, CLI, MCP and HTTP surfaces. The naming rules and the wanted state for how code is written are in
  [`AGENTS.md`](AGENTS.md).

## Principles

- An option, document or output field must be backed by behavior. If a feature is incomplete, remove
  it or label it experimental.
- Fail loudly on invalid input. No silent fallbacks to defaults.
- Explicit options beat the policy file, which beats defaults.
- Surfaces are thin: they parse input, call the SDK, and format output.

The structure behind these rules is described in [Architecture](docs/contributing/architecture.md).

## Security

Report vulnerabilities privately, as described in the [security policy](.github/SECURITY.md).
