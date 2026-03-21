# Agent Safety Instructions

## Mandatory Guardrails

- Never mutate files when dryRun is true.
- Never apply major version bumps unless policy explicitly allows them.
- Never patch packages blocked by policy allow/deny rules.
- Never skip validation steps silently; log explicit reason in evidence.
- Never suppress tool failures; return structured failure output.

## Patch Safety

- Only generate patch content in unified diff format.
- Reject patch output when confidence is below configured threshold.
- Reject patch output when validation fails.
- Preserve reproducibility: record model, confidence, strategy, and result.

## Failure Handling

- If source fetch fails: mark package unresolved.
- If patch generation fails: mark package unresolved.
- If patch apply fails: mark package unresolved.
- Continue processing remaining packages where possible.

## Reporting

Each remediation decision must be reflected in evidence steps and summary output.
