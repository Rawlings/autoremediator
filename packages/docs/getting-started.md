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
