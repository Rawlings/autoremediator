import { z } from "zod";

import { policyFileSchema, suppressionSchema } from "../../infra/policy/policy.js";
import { AUTONOMY_LEVEL_VALUES } from "../../infra/policy/schemas.js";
import { MAX_NOTE_LENGTH } from "./sanitize.js";

/** An npm package name or a `*` wildcard pattern over one. Nothing else can be written into a list. */
const PACKAGE_PATTERN = /^(?:@[a-z0-9*][a-z0-9._*-]*\/)?[a-z0-9*][a-z0-9._*-]*$/;
const packageName = z
  .string()
  .max(214)
  .regex(PACKAGE_PATTERN, "must be an npm package name or a wildcard pattern such as @scope/*");

const listEdit = z
  .object({
    add: z.array(packageName).max(50).optional(),
    remove: z.array(packageName).max(50).optional(),
  })
  .strict();

/** `CVE-YYYY-NNNN…` or a GHSA id. */
const ADVISORY_ID = /^(?:CVE-\d{4}-\d{4,}|GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})$/i;

function build() {
  /** A suppression the model may propose: the policy's own entry, but with a required, bounded expiry. */
  const suppressionProposal = suppressionSchema
    .omit({ cveId: true, notes: true, expiresAt: true })
    .extend({
      cveId: z.string().regex(ADVISORY_ID, "must be a CVE or GHSA id"),
      notes: z
        .string()
        .max(MAX_NOTE_LENGTH * 4)
        .optional(),
      expiresAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/, "must be a date such as 2027-01-31"),
    })
    .strict();

  /**
   * What a model may ask for: a patch over known policy keys, built from the real policy schema
   * (`policyFileSchema`), so a key or value the policy file rejects cannot be expressed. Keys that can
   * widen trust beyond the user's words (`recipes`, `patchConfidenceThresholds`, `skipUnreachable`)
   * are left out on purpose. Defaults are not applied: an absent key means "leave it alone".
   */
  const policyPatchSchema = z
    .object({
      allowMajorBumps: z.boolean().optional(),
      denyPackages: listEdit.optional(),
      allowPackages: listEdit.optional(),
      constraints: policyFileSchema.shape.constraints,
      exploitSignalOverride: policyFileSchema.shape.exploitSignalOverride,
      suppressions: z.array(suppressionProposal).max(20).optional(),
      sla: policyFileSchema.shape.sla,
      dispositionPolicy: policyFileSchema.shape.dispositionPolicy,
      containmentMode: z.boolean().optional(),
      escalationGraph: policyFileSchema.shape.escalationGraph,
      autonomy: z
        .object({ ceiling: z.enum(AUTONOMY_LEVEL_VALUES) })
        .strict()
        .optional(),
    })
    .strict();

  const explanationSchema = z
    .object({
      phrase: z
        .string()
        .min(1)
        .max(300)
        .describe("The words of the request this explains, copied exactly from it."),
      keys: z
        .array(z.string().min(1).max(120))
        .max(20)
        .describe(
          "Dotted policy keys this phrase set or confirmed, e.g. denyPackages or constraints.supplyChainPolicy.blockInstallScripts. Name the key even when the policy already had that value.",
        ),
    })
    .strict();

  const unsupportedSchema = z
    .object({
      phrase: z
        .string()
        .min(1)
        .max(300)
        .describe("The words of the request that cannot be expressed, copied exactly."),
      reason: z.string().min(1).max(300).describe("Why the policy file cannot express them."),
    })
    .strict();

  /** The whole structured answer a model must give. */
  const policyProposalSchema = z
    .object({
      patch: policyPatchSchema,
      explanations: z.array(explanationSchema).max(50),
      unsupported: z.array(unsupportedSchema).max(50),
    })
    .strict();

  return {
    patch: policyPatchSchema,
    proposal: policyProposalSchema,
    /** The policy keys a model may touch. Everything else in the policy file is out of reach. */
    keys: Object.keys(policyPatchSchema.shape) as readonly string[],
  };
}

let cached: ReturnType<typeof build> | undefined;

/**
 * The schemas, built on first use from the real policy schema. Built lazily so importing this module
 * costs nothing and does not require the policy module to be loaded first.
 */
export function policySchemas(): ReturnType<typeof build> {
  cached ??= build();
  return cached;
}

export type PolicyPatch = z.infer<ReturnType<typeof build>["patch"]>;
export type PolicyProposal = z.infer<ReturnType<typeof build>["proposal"]>;
