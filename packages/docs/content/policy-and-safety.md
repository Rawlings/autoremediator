# Policy and Safety

## Policy File

Create `.autoremediator.json`:

```json
{
  "allowMajorBumps": false,
  "denyPackages": ["lodash"],
  "allowPackages": []
}
```

## Safety Guarantees

- dry-run does not mutate files
- package allow/deny policy is enforced
- major bump policy is enforced
- failures return structured output
- patch validation failures are marked unresolved (not successful)

## Remediation Scope

- direct dependencies are auto-upgraded when a safe version exists
- indirect dependencies are reported, and can be routed through fallback patching or team-defined escalation policy

## Validation

- install/test use resolved package manager
- `--run-tests` enables test validation after apply
