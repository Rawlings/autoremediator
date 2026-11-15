---
name: scanner-parser-integration
argument-hint: Describe the scanner format or normalization behavior to modify.
description: Use when updating scanner input adapters, format detection, or normalized finding extraction for npm-audit, yarn-audit, and SARIF.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: runtime
user-invocable: true
---

# Scanner Parser Integration

## Scope

**Runtime behavior.** This skill governs how the tool ingests and normalizes scanner output at runtime. Read it when adding a new scanner format, fixing malformed input handling, or changing how CVE IDs are extracted from findings. It does not govern the public API shape or module layout.

## When to Use

- Adding/changing scan format parsing.
- Updating normalization logic in `packages/core/src/scanner/adapters/`.
- Handling malformed scanner output.
- Adding or updating yarn-audit parsing.

## Inputs

- Sample scanner payload(s).
- Current adapter behavior.
- Cross-format expectations for `npm-audit`, `yarn-audit`, and `sarif`.

## Outputs

- Updated adapter logic.
- Deterministic normalized findings.
- Added/updated parser tests.

## Guardrails

- Preserve existing formats unless explicitly deprecated.
- Never silently drop parse failures.
- Keep CVE extraction case-insensitive and deduplicated.

## Verification Checklist

- Format detection still works.
- Dedup behavior preserved.
- CI summary downstream still receives CVE IDs.
- `ScanInputFormat` supports all documented scanner formats.
