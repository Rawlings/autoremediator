/**
 * Package pre-installation security evaluator
 *
 * Used to evaluate security posture of an npm package before installing or updating it.
 * Queries OSV for known vulnerabilities, enriches with EPSS and CISA KEV exploit telemetry,
 * and recommends safe upgrade targets.
 */
import semver from "semver";
import { queryOsvPackage, parseOsvVuln } from "../intelligence/sources/osv.js";
import { fetchEpss } from "../intelligence/sources/epss.js";
import { fetchCisaKevFeed, findKevEntry } from "../intelligence/sources/cisa-kev.js";
import { fetchPackageVersions, findSafeUpgradeVersion } from "../intelligence/sources/registry.js";
import type {
  EvaluatePackageOptions,
  PackageEvaluationReport,
  VulnerabilityEvaluationEntry,
} from "../platform/types.js";

export async function evaluatePackage(
  packageName: string,
  options: EvaluatePackageOptions = {},
): Promise<PackageEvaluationReport> {
  const version = options.version?.trim();
  const enrich = options.enrichIntelligence !== false;

  let versions: string[] = [];
  let latestVersion: string | undefined;

  try {
    versions = await fetchPackageVersions(packageName);
    if (versions.length > 0) {
      const valid = versions.filter((v) => semver.valid(v)).sort((a, b) => semver.compare(a, b));
      latestVersion = valid[valid.length - 1];
    }
  } catch {
    // Registry lookup failure shouldn't abort OSV checks
  }

  let rawVulns: Awaited<ReturnType<typeof queryOsvPackage>> = [];
  try {
    rawVulns = await queryOsvPackage(packageName, version);
  } catch {
    rawVulns = [];
  }

  // Load CISA KEV feed if enrichment is enabled
  let kevFeed: Awaited<ReturnType<typeof fetchCisaKevFeed>> | null = null;
  if (enrich) {
    try {
      kevFeed = await fetchCisaKevFeed();
    } catch {
      kevFeed = null;
    }
  }

  const entries: VulnerabilityEvaluationEntry[] = [];

  for (const raw of rawVulns) {
    const cveDetails = parseOsvVuln(raw);
    const affected = cveDetails.affectedPackages.find(
      (p) => p.name.toLowerCase() === packageName.toLowerCase(),
    );

    // If a specific version was requested, verify semver matching
    if (version && affected?.vulnerableRange) {
      const cleanVer = semver.clean(version) || version;
      if (semver.valid(cleanVer) && !semver.satisfies(cleanVer, affected.vulnerableRange)) {
        continue;
      }
    }

    let inCisaKev = false;
    let epssScore: number | undefined;
    let epssPercentile: number | undefined;

    if (enrich && cveDetails.id.startsWith("CVE-")) {
      if (kevFeed) {
        inCisaKev = Boolean(findKevEntry(kevFeed, cveDetails.id));
      }
      try {
        const epss = await fetchEpss(cveDetails.id);
        if (epss) {
          epssScore = Number.parseFloat(epss.epss);
          epssPercentile = Number.parseFloat(epss.percentile);
        }
      } catch {
        // Soft fail on individual EPSS queries
      }
    }

    let safeUpgradeVersion: string | undefined;
    if (affected?.firstPatchedVersion) {
      try {
        const safe = await findSafeUpgradeVersion(
          packageName,
          version || "0.0.0",
          affected.firstPatchedVersion,
        );
        safeUpgradeVersion = safe ?? affected.firstPatchedVersion;
      } catch {
        safeUpgradeVersion = affected.firstPatchedVersion;
      }
    }

    entries.push({
      cveId: cveDetails.id,
      severity: cveDetails.severity,
      summary: cveDetails.summary,
      vulnerableRange: affected?.vulnerableRange,
      firstPatchedVersion: affected?.firstPatchedVersion,
      safeUpgradeVersion,
      epssScore,
      epssPercentile,
      inCisaKev,
      references: cveDetails.references,
    });
  }

  const isVulnerable = entries.length > 0;
  let verdict: PackageEvaluationReport["verdict"] = "safe";

  if (isVulnerable) {
    const hasKevOrHighEpss = entries.some((e) => e.inCisaKev || (e.epssScore && e.epssScore > 0.5));
    const hasHighOrCritical = entries.some(
      (e) => e.severity === "CRITICAL" || e.severity === "HIGH",
    );

    if (hasKevOrHighEpss) {
      verdict = "actively-exploited";
    } else if (hasHighOrCritical) {
      verdict = "vulnerable";
    } else {
      verdict = "caution";
    }
  }

  // Determine recommended safe version
  let recommendedVersion: string | undefined;
  if (isVulnerable) {
    const upgradeCandidates = entries
      .map((e) => e.safeUpgradeVersion)
      .filter((v): v is string => Boolean(v && semver.valid(v)))
      .sort((a, b) => semver.compare(a, b));

    recommendedVersion = upgradeCandidates[upgradeCandidates.length - 1] || latestVersion;
  } else {
    recommendedVersion = version || latestVersion;
  }

  const summary = isVulnerable
    ? `Package "${packageName}${version ? `@${version}` : ""}" has ${entries.length} known vulnerability(ies) (verdict: ${verdict}). Recommended safe version: ${recommendedVersion || "none"}.`
    : `Package "${packageName}${version ? `@${version}` : ""}" has no known vulnerabilities. Safe to install.`;

  return {
    schemaVersion: "1.0",
    packageName,
    evaluatedVersion: version,
    isVulnerable,
    verdict,
    summary,
    vulnerabilities: entries,
    recommendedVersion,
    latestVersion,
    generatedAt: new Date().toISOString(),
  };
}
