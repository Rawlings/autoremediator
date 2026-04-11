---
description: Safety guardrails for remediation decisions, mutation behavior, validation, and failure handling.
applyTo: packages/core/src/{remediation,platform}/**/*.ts
---

# Agent Safety Instructions

## Mandatory Guardrails

- Never mutate files when dryRun is true.
- Never apply major version bumps unless policy explicitly allows them.
- Never patch packages blocked by policy allow/deny rules.
- Never skip validation steps silently; log explicit reason in evidence.
- Never suppress tool failures; return structured failure output.
- Never report unresolved outcomes as successful remediation.

## Patch Safety

- Only generate patch content in unified diff format.
- Reject patch output when confidence is below configured threshold.
- Reject patch output when validation fails.
- Preserve reproducibility: record model, confidence, strategy, and result.
- Preserve patch artifact metadata and validation phases when patch fallback is attempted.

## Failure Handling

- If source fetch fails: mark package unresolved.
- If patch generation fails: mark package unresolved.
- If patch apply fails: mark package unresolved.
- If override application fails for a transitive dependency: mark unresolved with explicit reason and continue.
- Continue processing remaining packages where possible.

## Reporting

Each remediation decision must be reflected in evidence steps and summary output.

CI-facing summary fields must remain deterministic and machine-readable.
