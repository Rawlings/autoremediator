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

## Validation

- install/test use resolved package manager
- `--run-tests` enables test validation after apply
