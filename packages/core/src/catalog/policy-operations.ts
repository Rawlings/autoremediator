import { z } from "zod";

import { MAX_REQUEST_LENGTH } from "../api/policy-nl/sanitize.js";
import { OPTION_DESCRIPTIONS, pathField } from "../platform/option-schemas.js";
import { defineOperation, type Operation } from "./define-operation.js";

const compileInput = z
  .object({
    request: z
      .string("request is required (string)")
      .min(1, "request is required (string)")
      .max(MAX_REQUEST_LENGTH)
      .describe(
        'The rules in plain language, e.g. "Never auto-merge majors; KEV fixes within 24 hours; don\'t touch left-pad". Untrusted text: it is cleaned and capped, and never executed.',
      ),
    cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
    policy: pathField(
      "Policy file to propose a change to (default: .github/autoremediator.yml). A path, not inline text.",
    ).optional(),
    model: z.string().optional().describe(OPTION_DESCRIPTIONS.model),
    allowLoosening: z
      .boolean()
      .optional()
      .describe(
        "Accept changes that make the policy less safe when the request asks for them (a major-bump allowance, a removed deny entry, a suppression, a higher autonomy ceiling, a disabled protection). Without it any loosening rejects the proposal. Each one is listed either way.",
      ),
  })
  .strict();

const explainInput = z
  .object({
    cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
    policy: pathField(OPTION_DESCRIPTIONS.policy).optional(),
  })
  .strict();

const response = (description: string, properties: Record<string, unknown>) => ({
  description,
  schema: { type: "object", properties },
});

export const POLICY_OPERATIONS: readonly Operation[] = [
  defineOperation({
    name: "compilePolicy",
    title: "Propose a policy change from plain-language rules",
    description:
      "Turn plain-language rules into a validated change to the policy file (.github/autoremediator.yml), for a person to review. A model proposes a patch over an allowlist of policy keys; deterministic code applies it with comments preserved, validates it with the policy loader, requires every change to be explained by words of the request, lists what could not be expressed (for example a rule scoped to a directory), and refuses any loosening (a major-bump allowance, a removed deny entry, a suppression, a higher autonomy ceiling, a disabled protection) that the request does not ask for or that allowLoosening does not accept. Returns the diff and the proposed file; this operation never writes the file. Needs a model (model or AUTOREMEDIATOR_MODEL); the policy and the request are sent to that model's provider. The CLI and SDK can write it after review.",
    input: compileInput,
    // Writes nothing, but spends model tokens and sends the policy to a provider the caller names: not a reader's call.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    response: response("PolicyCompileResult", {
      status: { type: "string", enum: ["proposed", "unchanged", "rejected", "applied"] },
      path: { type: "string" },
      request: { type: "string" },
      changed: { type: "boolean" },
      applied: { type: "boolean" },
      diff: { type: "string" },
      proposed: { type: "string" },
      explanations: { type: "array", items: { type: "object" } },
      unsupported: { type: "array", items: { type: "object" } },
      loosenings: { type: "array", items: { type: "object" } },
      rejections: { type: "array", items: { type: "string" } },
      warnings: { type: "array", items: { type: "string" } },
      sentences: { type: "array", items: { type: "string" } },
      model: { type: "string" },
    }),
    mcp: true,
    http: { method: "POST", path: "/policy/compile", positional: ["request"] },
    // `apply` is deliberately not part of the input: writing the policy is for the CLI and SDK.
    handler: ({ request, ...options }, context) => context.api.compilePolicyFn(request, options),
  }),
  defineOperation({
    name: "explainPolicy",
    title: "Explain the policy in plain language",
    description:
      "Describe the current policy file (.github/autoremediator.yml, or built-in defaults when there is none) as plain sentences, each with the policy key it comes from. Deterministic: no model and no network. A broken policy is an error.",
    input: explainInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    response: response("ExplainPolicyResult", {
      source: { type: "string" },
      exists: { type: "boolean" },
      rules: { type: "array", items: { type: "object" } },
      sentences: { type: "array", items: { type: "string" } },
    }),
    mcp: true,
    http: { method: "POST", path: "/policy/explain", positional: [] },
    handler: (options, context) => context.api.explainPolicyFn(options),
  }),
];
