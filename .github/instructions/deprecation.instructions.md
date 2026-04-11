---
description: Deprecation and removal workflow for public behavior, options, and contracts.
applyTo: packages/core/src/**/*.ts,packages/docs/**/*.md,README.md,CONTRIBUTING.md,AGENTS.md
---

# Deprecation Instructions

## Scope

Use phased deprecation for user-facing options, commands, fields, and operations.

## Deprecation Workflow

1. Mark as deprecated with replacement guidance.
2. Document deprecation in changelog/docs.
3. Preserve behavior during deprecation window unless unsafe.
4. Remove in planned release with explicit release note.

## Required Updates

- Update API/CLI docs and migration guidance.
- Update changelog with deprecation and replacement path.
- Update governance docs if tool order/contracts changed.

## Guardrails

- Do not remove public behavior silently.
- Do not keep deprecated aliases indefinitely without clear policy.

## Verification

- Confirm replacement path exists and is documented.
- Confirm release notes clearly state removal timeline.
