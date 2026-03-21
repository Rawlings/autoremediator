# Scanner Inputs

Supported formats:

- `npm-audit`
- `yarn-audit`
- `sarif`
- `auto`

## npm audit

```bash
npm audit --json > audit.json
autoremediator audit.json --format npm-audit
```

## pnpm audit

```bash
pnpm audit --json > pnpm-audit.json
autoremediator pnpm-audit.json --format npm-audit
```

## yarn audit

```bash
yarn npm audit --json > yarn-audit.json
autoremediator yarn-audit.json --format yarn-audit
```

## SARIF

```bash
autoremediator report.sarif --format sarif
```
