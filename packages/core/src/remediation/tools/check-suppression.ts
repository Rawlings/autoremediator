/**
 * Tool: check-suppression
 *
 * Matches a CVE ID against the active VEX suppressions in the policy.
 * A suppression is active when its expiresAt is absent or in the future.
 */
import { tool } from "ai";
import { z } from "zod";
import { isActiveSuppression } from "../../platform/policy.js";
import type { VexJustification } from "../../platform/types.js";

const suppressionSchema = z.object({
  cveId: z.string(),
  justification: z.enum(["not_affected", "fixed", "mitigated", "under_investigation"]),
  notes: z.string().optional(),
  expiresAt: z.string().optional(),
});

export const checkSuppressionTool = tool({
  description:
    "Check whether a CVE is suppressed by an active VEX suppression entry in the policy. Returns suppressed=true and the justification if an active match is found. Call this after check-version-match.",
  parameters: z.object({
    cveId: z.string().describe("The CVE ID to look up in suppressions"),
    suppressions: z
      .array(suppressionSchema)
      .describe("The suppressions array from the loaded policy"),
  }),
  execute: async ({ cveId, suppressions }): Promise<{
    suppressed: boolean;
    justification?: VexJustification;
    notes?: string;
  }> => {
    const match = suppressions.find(
      (s) => s.cveId === cveId && isActiveSuppression(s)
    );

    if (!match) {
      return { suppressed: false };
    }

    return {
      suppressed: true,
      justification: match.justification as VexJustification,
      notes: match.notes,
    };
  },
});
