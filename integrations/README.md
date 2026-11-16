# Integrations

Everything here is meant to be copied, installed or called from outside the repository, as opposed to
the code in `packages/`.

| Folder | What it is |
|---|---|
| `claude-code/` | The Claude Code plugin. `../.claude-plugin/marketplace.json` makes this repository a marketplace for it; see [Coding agents](../docs/integrations/coding-agents.md). |
| `ci-templates/` | Pipeline templates for GitLab, Bitbucket and Azure DevOps; see [Other CI](../docs/integrations/other-ci.md). |
| `dagger/` | A Dagger module that runs the CLI in a container. |

The `claude-code/` files are generated from `packages/core/src/features/init/` (the same text
`autoremediator init` writes into a project), and a test fails when they drift. After changing that text,
regenerate them:

```bash
UPDATE_PLUGINS=1 pnpm --filter autoremediator exec vitest run plugin-files
```
