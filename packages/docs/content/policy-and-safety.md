# Policy and Safety

Policy controls decide what is allowed.

Safety controls decide what is considered successful.

Use both together to run remediation automation without silent risk acceptance.

Related references:

- [CLI Reference](cli.md)
- [Getting Started](getting-started.md)
- [Integrations](integrations.md)

## Policy Configuration

Create `.autoremediator.json`:

```json
{
  "allowMajorBumps": false,
  "denyPackages": ["lodash"],
  "allowPackages": []
}
```

Field intent:

- `allowMajorBumps`:
  - what: permits major-version remediation changes
  - why: major upgrades can break runtime behavior
  - guidance: keep `false` by default unless your release governance explicitly supports major upgrades
- `denyPackages`:
  - what: packages the automation must not modify
  - why: protect sensitive dependencies with manual review requirements
- `allowPackages`:
  - what: optional allowlist boundary
  - why: limit automation scope during staged rollout

## Precedence Rules

When settings conflict, precedence is:

1. explicit CLI/API options
2. policy file values
3. runtime defaults

Why this matters:

- platform teams can enforce baseline safety in policy files
- pipeline owners can override only when explicitly intended
- defaults remain predictable when options are omitted

## Safety Guarantees

Core guardrails:

- dry-run must not mutate files
- package allow/deny policy must be enforced
- major bump policy must be enforced
- tool failures must surface in structured outputs
- failed patch validation must be marked unresolved (never success)

These guarantees are critical for trustable automation in CI.

## Remediation Scope and Escalation

- direct dependencies:
  - primary automatic upgrade target when safe fixed versions exist
- indirect dependencies:
  - may be unresolved when no safe direct bump path exists
  - should route through team escalation or controlled fallback strategy

Why this distinction exists: direct dependency changes are typically auditable and reviewable in repository context, while indirect fixes can require broader dependency graph decisions.

## Fallback Safety Path

When a safe version bump cannot be applied, fallback may attempt:

1. source fetch
2. patch generation
3. patch apply (if confidence and validation gates pass)

Safety implications:

- low-confidence patch output must not be applied
- validation failures must be unresolved outcomes
- unresolved results must remain visible for manual handling

## Validation Controls

- install/test validation uses the resolved package manager for the repository
- `--run-tests` enables post-apply test validation and should be used in mutation-enabled automation
- `--dry-run` is the onboarding and policy-tuning baseline for new projects

## Security Best-Practice Baseline

- start with dry-run in all new repositories
- enable CI summary artifacts and retain evidence data
- require review + branch protection for auto-generated remediation PRs
- keep major bumps blocked unless a team explicitly accepts that risk class
- treat unresolved findings as an escalation queue

## Troubleshooting Policy Outcomes

- package unexpectedly skipped:
  - verify allow/deny package rules
  - verify CLI overrides were not supplied in the job
- expected major bump did not happen:
  - check `allowMajorBumps`
  - confirm resolved version actually requires a major jump
- unresolved after fallback attempt:
  - inspect validation outcome
  - review confidence gating behavior and escalation process

## Related Docs

- [CLI Reference](cli.md)
- [Integrations](integrations.md)
- [Scanner Inputs](scanner-inputs.md)
