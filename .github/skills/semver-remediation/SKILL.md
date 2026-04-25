---
name: semver-remediation
argument-hint: Describe the vulnerable range or upgrade-selection behavior to adjust.
description: Use when changing vulnerable range matching, fixed-version selection, or version-bump behavior.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: runtime
user-invocable: true
---

# Semver Remediation

## Scope

**Runtime behavior.** This skill governs how the tool evaluates installed versions against vulnerable ranges, selects safe upgrades, and applies version bumps at runtime. Read it when version matching produces wrong results or upgrade selection needs adjustment. It does not govern module layout or API contracts.

## When to Use

- Updating semver checks in `packages/core/src/remediation/tools/check-version-match.ts`.
- Modifying fixed version resolution in `packages/core/src/intelligence/sources/registry.ts`.
- Adjusting bump application behavior in `packages/core/src/remediation/tools/apply-version-bump.ts`.

## Inputs

- vulnerableRange data.
- installed package versions.
- registry versions.

## Outputs

- Correct vulnerable package detection.
- Lowest safe version selection.
- Stable PatchResult strategy field.
- Touchpoint impact classification for user-visible behavior changes (`not-affected` vs `requires updates`) across SDK/CLI/MCP/OpenAPI/docs.

## Guardrails

- Never propose downgrades.
- Respect major bump policy at apply time.
- Return strategy="none" when safe upgrade is unavailable.
- If semver behavior changes alter report fields/reasons/outcomes, verify and update all public delivery surfaces in the same change set.

## Verification Checklist

- Matching behavior aligns with semver expectations.
- Policy guardrails remain enforced.
- Dry-run and apply modes produce consistent intent.
