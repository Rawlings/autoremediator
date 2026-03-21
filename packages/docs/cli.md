# CLI Reference

## Command Modes

```bash
autoremediator CVE-2021-23337
autoremediator ./audit.json
autoremediator --input ./scan.json --format auto
```

Explicit commands:

```bash
autoremediator cve CVE-2021-23337
autoremediator scan --input ./audit.json --format npm-audit
```

## Core Options

- `--cwd <path>`
- `--package-manager <npm|pnpm|yarn>`
- `--dry-run`
- `--run-tests`
- `--llm-provider <openai|anthropic|local>`
- `--json`

Scan mode options:

- `--input <path>`
- `--format <auto|npm-audit|yarn-audit|sarif>`
- `--policy <path>`
- `--ci`
- `--summary-file <path>`
- `--no-evidence`

## CI Exit Codes

- `0`: no failed remediations
- `1`: one or more failed remediations
