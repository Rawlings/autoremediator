# @autoremediator/github-app

GitHub App service for automated vulnerability remediation and pull request lifecycle management.

## Capabilities

- **Webhook Ingestion** — responds to Dependabot alerts, GitHub Security Advisories, push events, and check suite completions.
- **Durable Job Queue** — in-memory and disk-backed queue with exponential backoff and concurrency limits.
- **Automated Remediation** — applies version upgrades, lockfile reconciliation, and patch files on dedicated branches.
- **PR Auto-Healing** — monitors check run failures on remediation branches (`autoremediator/*`), parses TypeScript compiler diagnostics, linter output, and test assertions, and commits iterative fixes (default: up to 3 attempts).
- **Escalation Routing** — flags unresolvable branches with `autoremediator/needs-human-review` and posts diagnostic summaries for maintainers.

## License

MIT
