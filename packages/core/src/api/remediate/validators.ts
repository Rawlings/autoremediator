export function assertValidCveId(cveId: string): void {
  if (!/^CVE-\d{4}-\d+$/i.test(cveId)) {
    throw new Error(
      `Invalid CVE ID: "${cveId}". Expected format: CVE-YYYY-NNNNN (e.g. CVE-2021-23337).`
    );
  }
}