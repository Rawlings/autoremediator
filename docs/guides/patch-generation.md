# Patch generation

When no safe version exists, Autoremediator can ask a language model to patch the vulnerable
package. This is the only model call in the tool, and it is off until you configure one.

## Enable it

Name a model as `<provider>:<model-id>` and install that provider's AI SDK package. The provider
reads its API key from its own standard variable.

```bash
npm install @ai-sdk/anthropic
export ANTHROPIC_API_KEY=...
autoremediator CVE-2021-23337 --model anthropic:claude-sonnet-5-5
```

`AUTOREMEDIATOR_MODEL` sets the default. `<provider>` maps to the package `@ai-sdk/<provider>`
(`anthropic`, `openai`, `google`, and so on). Without a model, a case that needs a patch is reported
as `requires-llm-fallback`.

## What happens

1. The published source of the vulnerable package version is fetched from the registry.
2. The model receives the advisory summary and that source, and returns the new contents of the files
   that must change.
3. The result is turned into a diff, syntax-checked, and given a confidence score.
4. A patch below the threshold for its risk level is rejected. The defaults are `0.65` (low),
   `0.7` (medium) and `0.8` (high); change them with `--patch-confidence-low|medium|high` or
   `patchConfidenceThresholds` in the [policy file](../reference/policy-file.md).
5. An accepted patch is written to the patches directory as a `.patch` file with a manifest,
   applied, and verified like any other change.

Token counts are recorded in the report as `llmUsage`. The model never runs code, and tests it
writes are discarded. See [Safety](../safety.md).

## Review and maintain patches

```bash
autoremediator patches list
autoremediator patches inspect patches/lodash+4.17.20.patch
autoremediator patches validate patches/lodash+4.17.20.patch
autoremediator patches reconcile
```

`validate` checks a patch against its manifest and the installed dependency. `reconcile` retires
patches that an upstream release has since made obsolete.

## Bring your own generator

Skip the model integration by passing an object that implements `PatchGenerator`
(`propose(request) → proposal`) as `patchGenerator` in the [SDK](../reference/sdk.md). The same
validation and confidence gates apply. `createLlmPatchGenerator` builds one from any AI SDK model.
