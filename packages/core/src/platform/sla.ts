/**
 * SLA breach computation utility.
 *
 * Computes SLA breach records by comparing CVE publication dates against
 * configured SLA windows (in hours) per severity level.
 */
import type { CveSeverity, SlaBreach, SlaPolicy } from "./types.js";

interface CvePublicationEntry {
  cveId: string;
  publishedAt?: string;
  severity: string;
}

export function computeSlaBreaches(
  cveDetailsList: CvePublicationEntry[],
  slaPolicy: SlaPolicy
): SlaBreach[] {
  const breaches: SlaBreach[] = [];
  const now = new Date();

  for (const entry of cveDetailsList) {
    if (!entry.publishedAt) continue;

    const severityKey = entry.severity.toLowerCase() as keyof SlaPolicy;
    const windowHours = slaPolicy[severityKey];
    if (windowHours == null) continue;

    const publishedDate = new Date(entry.publishedAt);
    if (isNaN(publishedDate.getTime())) continue;

    const deadlineDate = new Date(publishedDate.getTime() + windowHours * 60 * 60 * 1000);
    const hoursOverdue = (now.getTime() - deadlineDate.getTime()) / (1000 * 60 * 60);

    if (hoursOverdue > 0) {
      breaches.push({
        cveId: entry.cveId,
        severity: entry.severity.toUpperCase() as CveSeverity,
        publishedAt: entry.publishedAt,
        deadlineAt: deadlineDate.toISOString(),
        hoursOverdue: Math.round(hoursOverdue * 100) / 100,
      });
    }
  }

  return breaches;
}
