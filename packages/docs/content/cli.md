# CLI Reference

The CLI is the primary automation surface for CI, scheduled workflows, and operator-triggered remediation runs.

This page documents command behavior, option semantics, and safe automation patterns.

Related references:

- [Getting Started](getting-started.md)
- [Scanner Inputs](scanner-inputs.md)
- [Policy and Safety](policy-and-safety.md)
- [Integrations](integrations.md)

## Command Modes

Single CVE mode (short form):

```bash
autoremediator CVE-2021-23337
```

Scan input mode (short form):

```bash
autoremediator ./audit.json
autoremediator --input ./scan.json --format auto
```

Equivalent explicit subcommands:

```bash
autoremediator cve CVE-2021-23337
autoremediator scan --input ./audit.json --format npm-audit
```

When to use which mode:

- use direct CVE mode for urgent, targeted security response
- use scan mode for CI or scheduled automation where multiple findings are expected

## Core Options

| Option | What it controls | Why it matters in automation |
|---|---|---|
| `--cwd <path>` | target project directory | supports centralized runners operating across many repos |
| `--package-manager <npm|pnpm|yarn>` | install/update tool selection | avoids ambiguous lockfile detection in custom pipelines |
| `--dry-run` | simulation-only execution | validates policy and expected actions without file mutation |
| `--preview` | non-mutating remediation preview mode | enables planning flows without write side effects |
| `--run-tests` | post-apply validation | reduces risk of introducing breaking dependency changes |
| `--llm-provider <openai|anthropic|local>` | patch-generation provider selection | controls determinism, cost, and fallback behavior |
| `--request-id <id>` | request correlation id | links CLI runs to external orchestration traces |
| `--session-id <id>` | session correlation id | groups related remediation runs |
| `--parent-run-id <id>` | parent run linkage | supports hierarchical trace chains in evidence |
| `--idempotency-key <key>` | replay-safe execution key | enables cached resume behavior for repeated jobs |
| `--resume` | reuse cached result for same idempotency key | prevents duplicate remediation work in retried pipelines |
| `--actor <name>` | actor identity metadata | adds provenance context to evidence output |
| `--source <src>` | source system metadata | tags run origin (`cli`, `sdk`, `mcp`, `openapi`, `unknown`) |
| `--direct-dependencies-only` | direct-only remediation constraint | blocks indirect dependency result application |
| `--prefer-version-bump` | bump-only remediation constraint | rejects patch-file outcomes when bump policy is required |
| `--json` | machine-readable output | simplifies CI parsing and SIEM ingestion |

## Scan Mode Options

| Option | What it controls | Why it matters in automation |
|---|---|---|
| `--input <path>` | scanner file path | enables scanner-to-remediation pipelines |
| `--format <auto|npm-audit|yarn-audit|sarif>` | parser adapter selection | improves reliability for mixed scanner ecosystems |
| `--policy <path>` | policy file path | enforces organization-specific safety controls |
| `--evidence` | enables evidence artifact writing | explicit positive control for evidence output |
| `--ci` | non-interactive CI behavior | deterministic summary/exit semantics for gating |
| `--summary-file <path>` | summary artifact output | preserves auditable run metadata for dashboards |
| `--no-evidence` | disables evidence artifact writing | use when evidence must be suppressed for a specific run |

## What `--ci` Changes

`--ci` is designed for deterministic, non-interactive environments:

- stable summary semantics suitable for pipeline gating
- explicit unresolved/failure signaling
- no interactive prompts

Pairing recommendations:

- `--ci --summary-file ./summary.json` for machine-consumed gate results
- `--ci --dry-run` for pre-merge guardrails that do not mutate dependencies

## Dry-Run Semantics

When `--dry-run` is enabled:

- dependency graph analysis and decision logic still run
- policy checks still apply
- file mutations must not occur
- unresolved reasons still surface for operator action

Use `--dry-run` first when onboarding a new repository or policy file.

## Provider Selection Guidance

| Provider | Recommended use | Considerations |
|---|---|---|
| `local` (deterministic mode) | regulated or air-gapped automation, repeatable CI | avoids remote model calls and LLM patch generation |
| `openai` | broad patch quality needs | external network and credential requirements |
| `anthropic` | alternate model path with similar workflow | external network and credential requirements |

For governance implications, see [Policy and Safety](policy-and-safety.md).

## Automation Examples

Single CVE dry-run preview:

```bash
autoremediator CVE-2021-23337 --dry-run --json

# explicit preview + correlation context
autoremediator cve CVE-2021-23337 --preview --request-id req-42 --session-id nightly-security --json

# resumable + constrained run
autoremediator CVE-2021-23337 --idempotency-key nightly-cve-2021-23337 --resume --direct-dependencies-only --prefer-version-bump --actor sec-bot --source cli --json
```

CI scanner gate with summary artifact:

```bash
autoremediator scan --input ./audit.json --format auto --ci --summary-file ./summary.json
```

Policy-controlled remediation with validation:

```bash
autoremediator CVE-2021-23337 --policy ./.autoremediator.json --run-tests
```

Deterministic mode run:

```bash
autoremediator ./audit.json --format auto --llm-provider local --ci
```

## CI Exit Behavior

Current CI exit semantics:

- `0`: no failed remediations
- `1`: one or more failed remediations

Use summary data to distinguish fully remediated, partially remediated, and unresolved outcomes in downstream automation.

## Troubleshooting

- output seems incomplete:
	- add `--json` for structured parsing
	- write `--summary-file` and inspect unresolved details
- scan parsing issues:
	- specify `--format` explicitly instead of `auto`
	- validate scanner file shape with [Scanner Inputs](scanner-inputs.md)
- remediations blocked unexpectedly:
	- verify `--policy` path and contents
	- check package allow/deny controls in [Policy and Safety](policy-and-safety.md)

## Related Docs

- [Getting Started](getting-started.md)
- [Policy and Safety](policy-and-safety.md)
- [Integrations](integrations.md)
