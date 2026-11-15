import type { SlaPolicy } from "../../infra/policy/types.js";
import type { CveSeverity } from "../../shared/types.js";
import type { SlaBreach } from "./types.js";

/**
 * Whether a CVE has outlived the time the policy allows for its severity. Returns the breach, or
 * `null` when the CVE is within its window or the policy sets no window for that severity.
 */
export function checkSlaBreach(
  cveId: string,
  severity: CveSeverity,
  publishedAt: string,
  slaPolicy: SlaPolicy,
): SlaBreach | null {
  if (typeof severity !== "string" || !slaPolicy || typeof slaPolicy !== "object") {
    return null;
  }
  const severityKey = severity.toLowerCase() as keyof SlaPolicy;
  const deadlineHours = slaPolicy[severityKey];
  if (typeof deadlineHours !== "number") return null;

  const publishedMs = new Date(publishedAt).getTime();
  if (Number.isNaN(publishedMs)) return null;

  const deadlineMs = publishedMs + deadlineHours * 60 * 60 * 1000;
  const nowMs = Date.now();
  if (nowMs <= deadlineMs) return null;

  const hoursOverdue = Math.round((nowMs - deadlineMs) / (60 * 60 * 1000));
  return {
    cveId,
    severity,
    publishedAt,
    deadlineAt: new Date(deadlineMs).toISOString(),
    hoursOverdue,
  };
}
