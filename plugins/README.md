# Agent plugins

`claude-code/` is the Claude Code plugin; `../.claude-plugin/marketplace.json` makes this repository
a marketplace for it. See [Coding agents](../docs/integrations/coding-agents.md) for how to install it.

These files are generated from `packages/core/src/api/init/` (the same text `autoremediator init`
writes into a project), and a test fails when they drift. After changing that text, regenerate them:

```bash
UPDATE_PLUGINS=1 pnpm --filter autoremediator exec vitest run plugin-files
```
