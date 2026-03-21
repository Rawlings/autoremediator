# Migration Guide: npm to pnpm

## Command Mapping

- `npm install` -> `pnpm install`
- `npm run build` -> `pnpm build`
- `npm test` -> `pnpm test`
- `npx autoremediator` -> `pnpm exec autoremediator`

## Package Manager Override

```bash
autoremediator CVE-2021-23337 --package-manager pnpm
```

If omitted, the runtime auto-detects package manager by lockfile.

## Team Rollout Checklist

- standardize contributor commands on pnpm
- update CI cache/install steps
- update docs and automation scripts
- keep temporary npm fallback guidance during transition
