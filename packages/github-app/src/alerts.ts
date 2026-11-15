/** Advisory ids from alert webhooks. Only strictly matching ids are returned. */
const CVE = /\bCVE-\d{4}-\d{4,7}\b/gi;
const GHSA = /\bGHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b/gi;

export interface AlertTarget {
  /** Ids to remediate, preferring the CVE over the GHSA for the same advisory. */
  advisoryIds: string[];
  severity?: string;
  packageName?: string;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function idsIn(...texts: Array<string | undefined>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const id of text.match(CVE) ?? []) found.add(id.toUpperCase());
    for (const id of text.match(GHSA) ?? []) found.add(id.toUpperCase());
  }
  return [...found];
}

/** A Dependabot alert names its advisory and the package that is affected. */
export function dependabotAlertTarget(payload: Record<string, unknown>): AlertTarget | undefined {
  const alert = obj(payload.alert);
  const advisory = obj(alert?.security_advisory);
  const cve = str(advisory?.cve_id);
  const ghsa = str(advisory?.ghsa_id);
  const advisoryIds = idsIn(cve).length > 0 ? idsIn(cve) : idsIn(ghsa);
  if (advisoryIds.length === 0) return undefined;
  return {
    advisoryIds,
    severity: str(advisory?.severity),
    packageName: str(obj(obj(alert?.dependency)?.package)?.name),
  };
}

/**
 * A code scanning alert is only usable when the scanner reports an advisory (dependency scanners
 * such as Trivy or Grype use the CVE as the rule id). Anything else is ignored.
 */
export function codeScanningAlertTarget(payload: Record<string, unknown>): AlertTarget | undefined {
  const alert = obj(payload.alert);
  const rule = obj(alert?.rule);
  const advisoryIds = idsIn(str(rule?.id), str(rule?.name));
  if (advisoryIds.length === 0) return undefined;
  return { advisoryIds, severity: str(rule?.security_severity_level) ?? str(rule?.severity) };
}
