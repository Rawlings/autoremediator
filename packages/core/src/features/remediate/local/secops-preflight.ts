import { isActiveSuppression, loadSuppressionsFile } from "../../../infra/policy/policy.js";
import type {
  ExploitSignalOverridePolicy,
  SlaPolicy,
  VexSuppression,
} from "../../../infra/policy/types.js";
/**
 * SecOps pre-flight checks for the local remediation pipeline.
 *
 * Runs before inventory and per-package remediation:
 *   1. VEX suppression — stops remediation if the CVE is actively suppressed
 *   2. Exploit signal — KEV / EPSS override gate
 *   3. SLA breach — detects response-window violations
 */
import type { CveDetails } from "../../intelligence/types.js";
import { checkSlaBreach } from "../sla.js";
import { checkExploitSignalTool } from "../tools/check-exploit-signal.js";
import type { SlaBreach } from "../types.js";

export interface SecOpsPreflightOptions {
  suppressions: VexSuppression[];
  suppressionsFile?: string;
  exploitSignalOverride?: ExploitSignalOverridePolicy;
  slaCheck: boolean;
  slaPolicy?: SlaPolicy;
}

export type SecOpsPreflightResult =
  | { suppressed: true; summary: string; suppression: VexSuppression }
  | {
      suppressed: false;
      exploitSignalTriggered?: boolean;
      slaBreaches?: SlaBreach[];
    };

export async function runSecOpsPreflight(
  normalizedId: string,
  cveDetails: CveDetails,
  opts: SecOpsPreflightOptions,
): Promise<SecOpsPreflightResult> {
  const allSuppressions = opts.suppressionsFile
    ? [...opts.suppressions, ...loadSuppressionsFile(opts.suppressionsFile)]
    : opts.suppressions;

  const activeSuppression = allSuppressions.find(
    (s) => s.cveId === normalizedId && isActiveSuppression(s),
  );
  if (activeSuppression) {
    return {
      suppressed: true,
      summary: `CVE ${normalizedId} suppressed by VEX policy: ${activeSuppression.justification}${activeSuppression.notes ? ` — ${activeSuppression.notes}` : ""}`,
      suppression: activeSuppression,
    };
  }

  let exploitSignalTriggered: boolean | undefined;
  if (opts.exploitSignalOverride) {
    const result = await checkExploitSignalTool.execute({
      cveDetails: {
        id: cveDetails.id,
        kev: cveDetails.kev,
        epss: cveDetails.epss,
      },
      policy: { exploitSignalOverride: opts.exploitSignalOverride },
    });
    if (result.exploitSignalTriggered) {
      exploitSignalTriggered = true;
    }
  }

  let slaBreaches: SlaBreach[] | undefined;
  if (opts.slaCheck && opts.slaPolicy && cveDetails.publishedAt) {
    const breach = checkSlaBreach(
      normalizedId,
      cveDetails.severity,
      cveDetails.publishedAt,
      opts.slaPolicy,
    );
    if (breach) {
      slaBreaches = [breach];
    }
  }

  return { suppressed: false, exploitSignalTriggered, slaBreaches };
}
