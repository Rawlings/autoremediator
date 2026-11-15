export const CVE_ID_REGEX = /^CVE-\d{4}-\d{1,7}$/i;
export const GHSA_ID_REGEX = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;

export function isVulnerabilityId(id: string): boolean {
  return CVE_ID_REGEX.test(id) || GHSA_ID_REGEX.test(id);
}

export function assertValidCveId(cveId: string): void {
  if (!isVulnerabilityId(cveId)) {
    throw new Error(
      `Invalid vulnerability ID: "${cveId}". Expected format: CVE-YYYY-NNNNN (e.g. CVE-2021-23337) or GHSA-xxxx-xxxx-xxxx.`,
    );
  }
}
