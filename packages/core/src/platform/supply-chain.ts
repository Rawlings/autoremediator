/**
 * Supply chain trust & anti-poisoning verification gate
 *
 * Inspects package metadata before auto-upgrades to protect against:
 * 1. Freshly published releases (e.g. account hijacking window < 48-72h)
 * 2. Malicious install scripts (preinstall/postinstall execution)
 * 3. Unattested builds when provenance is required
 */
import { httpClient } from "./http-client.js";
import type { SupplyChainPolicy } from "./types.js";

export interface PackageTrustVerdict {
  trusted: boolean;
  reason?: string;
  publishAgeHours?: number;
  hasInstallScripts?: boolean;
  hasProvenance?: boolean;
}

interface NpmPackumentVersion {
  name: string;
  version: string;
  scripts?: Record<string, string>;
  dist?: {
    attestations?: {
      url?: string;
      provenance?: { predicateType?: string };
    };
    tarball?: string;
    integrity?: string;
  };
  _hasShrinkwrap?: boolean;
}

interface NpmPackument {
  name: string;
  time?: Record<string, string>;
  versions?: Record<string, NpmPackumentVersion>;
}

export async function verifyPackageTrust(
  packageName: string,
  targetVersion: string,
  policy?: SupplyChainPolicy,
): Promise<PackageTrustVerdict> {
  if (
    !policy ||
    (!policy.minPublishAgeHours && !policy.blockInstallScripts && !policy.requireProvenance)
  ) {
    return { trusted: true };
  }

  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;

  let packument: NpmPackument | null = null;
  try {
    const res = await httpClient({
      url,
      headers: { Accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" },
    });
    if (res.ok && res.data) {
      packument = res.data as NpmPackument;
    }
  } catch (err) {
    // If registry is unreachable, fail closed only if strict policy
    const msg = err instanceof Error ? err.message : String(err);
    return {
      trusted: false,
      reason: `Could not verify supply-chain trust for "${packageName}@${targetVersion}": ${msg}`,
    };
  }

  if (!packument) {
    return {
      trusted: false,
      reason: `Package packument for "${packageName}" not found on registry.`,
    };
  }

  // 1. Check publish age
  let publishAgeHours: number | undefined;
  if (packument.time?.[targetVersion]) {
    const publishedAt = new Date(packument.time[targetVersion]).getTime();
    publishAgeHours = Math.max(0, (Date.now() - publishedAt) / (1000 * 60 * 60));

    if (policy.minPublishAgeHours && publishAgeHours < policy.minPublishAgeHours) {
      return {
        trusted: false,
        publishAgeHours,
        reason: `Target release "${packageName}@${targetVersion}" was published only ${publishAgeHours.toFixed(1)}h ago (minimum required age is ${policy.minPublishAgeHours}h).`,
      };
    }
  }

  const versionData = packument.versions?.[targetVersion];

  // 2. Check install lifecycle scripts
  const scripts = versionData?.scripts ?? {};
  const installScriptKeys = ["preinstall", "install", "postinstall"].filter((k) =>
    Boolean(scripts[k]),
  );
  const hasInstallScripts = installScriptKeys.length > 0;

  if (policy.blockInstallScripts && hasInstallScripts) {
    return {
      trusted: false,
      publishAgeHours,
      hasInstallScripts: true,
      reason: `Target release "${packageName}@${targetVersion}" defines risky lifecycle scripts (${installScriptKeys.join(", ")}).`,
    };
  }

  // 3. Check provenance attestation
  const hasProvenance = Boolean(
    versionData?.dist?.attestations?.provenance || versionData?.dist?.attestations?.url,
  );
  if (policy.requireProvenance && !hasProvenance) {
    return {
      trusted: false,
      publishAgeHours,
      hasInstallScripts,
      hasProvenance: false,
      reason: `Target release "${packageName}@${targetVersion}" does not have cryptographic build provenance attestations.`,
    };
  }

  return {
    trusted: true,
    publishAgeHours,
    hasInstallScripts,
    hasProvenance,
  };
}
