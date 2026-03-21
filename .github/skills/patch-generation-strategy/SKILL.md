---
name: patch-generation-strategy
argument-hint: Describe the patch generation strategy or confidence policy to update.
description: Use when changing fallback patch generation, unified diff creation, or patch confidence handling.
disable-model-invocation: false
license: MIT
metadata:
  owner: autoremediator
  scope: runtime
user-invocable: true
---

# Patch Generation Strategy

## Scope

**Runtime behavior.** This skill governs the fallback patching path that executes when no safe upgrade version exists. Read it when changing LLM prompt structure for diff generation, confidence thresholds, or patch validation logic. It does not govern module structure or how the patch output is exposed to callers.

## When to Use

- Updating `packages/core/src/remediation/tools/generate-patch.ts` prompt/response handling.
- Changing diff generation logic in `packages/core/src/remediation/strategies/patch-utils.ts`.
- Adjusting confidence thresholds.

## Inputs

- CVE details.
- vulnerable source files.
- category classifier output.

## Outputs

- Valid unified diff patch content.
- Structured confidence and risk output.

## Guardrails

- Output must be parseable JSON before diff generation.
- Patch content must include unified diff headers.
- Reject low-confidence patches according to threshold policy.

## Verification Checklist

- Parser tolerates model output noise.
- No patch file generated on malformed model response.
- Confidence/risk fields are always present on success.
