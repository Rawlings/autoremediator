# Getting Started

Autoremediator remediates Node.js dependency CVEs from either a CVE ID or a scanner output file.

## Install

```bash
pnpm add -g autoremediator
# or
npm install -g autoremediator
# or
yarn global add autoremediator
```

Project local:

```bash
pnpm add -D autoremediator
pnpm exec autoremediator --help
# or
npm install --save-dev autoremediator
npm exec autoremediator -- --help
# or
yarn add --dev autoremediator
yarn autoremediator --help
```

## Environment

```bash
export OPENAI_API_KEY=...
# or
export ANTHROPIC_API_KEY=...
```

## First Commands

```bash
autoremediator CVE-2021-23337
autoremediator ./audit.json
autoremediator CVE-2021-23337 --dry-run
autoremediator CVE-2021-23337 --run-tests
```

## Mode Notes

- `--llm-provider local` runs a deterministic remediation path without LLM patch generation.
- automatic version-bump remediation is strongest for direct dependencies.
