import semver from "semver";

import { findLookalike } from "./popular.js";
import type { GuardAlternative, GuardFinding } from "./types.js";

export interface PackumentVersion {
  version: string;
  scripts?: Record<string, string>;
  deprecated?: string;
  dist?: { attestations?: unknown };
}

/** The parts of a full npm packument that the checks read. */
export interface Packument {
  name: string;
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
  versions?: Record<string, PackumentVersion>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"] as const;

const hasInstallScripts = (v: PackumentVersion | undefined): boolean =>
  INSTALL_SCRIPTS.some((key) => Boolean(v?.scripts?.[key]));
const hasProvenance = (v: PackumentVersion | undefined): boolean => Boolean(v?.dist?.attestations);
const cleanText = (text: string): string => text.replaceAll(/\s+/g, " ").slice(0, 160);

/** Which version a range or tag installs. Prefers stable, non-deprecated releases. */
export function resolveVersion(
  packument: Packument,
  range: string | undefined,
): string | undefined {
  const tags = packument["dist-tags"] ?? {};
  const versions = packument.versions ?? {};
  if (!range) return tags.latest;
  if (range in tags) return tags[range];
  if (semver.valid(range) && versions[range]) return range;
  const all = Object.keys(versions).filter((v) => semver.valid(v));
  const stable = all.filter((v) => !semver.prerelease(v) && !versions[v]?.deprecated);
  return semver.maxSatisfying(stable, range) ?? semver.maxSatisfying(all, range) ?? undefined;
}

export interface JudgeInput {
  packument: Packument;
  version: string;
  now: number;
  minPublishAgeHours: number;
}

/** Checks that need only the registry document. */
export function judgePackument(input: JudgeInput): {
  findings: GuardFinding[];
  alternative?: GuardAlternative;
} {
  const { packument, version, now, minPublishAgeHours } = input;
  const findings: GuardFinding[] = [];
  let alternative: GuardAlternative | undefined;
  const versions = packument.versions ?? {};
  const current = versions[version];
  const name = packument.name;

  const publishedAt = packument.time?.[version] ? Date.parse(packument.time[version]) : Number.NaN;
  const ageMs = now - publishedAt;

  // Look-alike names are only worrying for packages that have not been around long.
  const lookalike = findLookalike(name);
  if (lookalike) {
    const created = packument.time?.created ? Date.parse(packument.time.created) : Number.NaN;
    const young = Number.isFinite(created) && now - created < 30 * DAY;
    findings.push({
      check: "typosquat",
      severity: young ? "block" : "warn",
      message: `"${name}" looks like "${lookalike}"${young ? ", and was first published less than 30 days ago" : ""}. Check that you meant it.`,
    });
    alternative = { packageName: lookalike, reason: "the widely used package with a similar name" };
  }

  if (Number.isFinite(ageMs) && minPublishAgeHours > 0 && ageMs < minPublishAgeHours * HOUR) {
    findings.push({
      check: "cooldown",
      severity: "block",
      message: `${name}@${version} was published ${(ageMs / HOUR).toFixed(1)} hours ago; the minimum age is ${minPublishAgeHours} hours. New releases are where compromised packages show up first.`,
    });
    const cutoff = now - minPublishAgeHours * HOUR;
    const older = Object.keys(versions)
      .filter((v) => semver.valid(v) && !semver.prerelease(v) && !versions[v]?.deprecated)
      .filter((v) => Date.parse(packument.time?.[v] ?? "") < cutoff)
      .toSorted((a, b) => semver.rcompare(a, b))[0];
    if (older) {
      alternative = {
        packageName: name,
        version: older,
        reason: "the newest release that is old enough",
      };
    }
  }

  // Compare with the release before this one.
  const earlier = Object.keys(versions)
    .filter((v) => semver.valid(v) && !semver.prerelease(v) && semver.lt(v, version))
    .toSorted((a, b) => semver.rcompare(a, b))[0];
  const previous = earlier ? versions[earlier] : undefined;

  if (hasInstallScripts(current)) {
    const added = previous !== undefined && !hasInstallScripts(previous);
    const recent = Number.isFinite(ageMs) && ageMs < 7 * DAY;
    findings.push({
      check: "install-scripts",
      severity: added && recent ? "block" : "warn",
      message: added
        ? `${name}@${version} runs install scripts that ${earlier} did not${recent ? ", and it was published this week" : ""}. Install scripts run code on your machine at install time.`
        : `${name}@${version} runs install scripts (${INSTALL_SCRIPTS.filter((k) => current?.scripts?.[k]).join(", ")}).`,
    });
  }

  if (!hasProvenance(current) && hasProvenance(previous)) {
    findings.push({
      check: "provenance",
      severity: "warn",
      message: `${earlier} was published with build provenance and ${version} was not. A release made outside the usual pipeline can mean a stolen publish token.`,
    });
  }

  if (current?.deprecated) {
    findings.push({
      check: "deprecated",
      severity: "warn",
      message: `${name}@${version} is deprecated: ${cleanText(current.deprecated)}`,
    });
  }

  return { findings, ...(alternative ? { alternative } : {}) };
}

export function verdictOf(findings: readonly GuardFinding[]): "allow" | "warn" | "block" {
  if (findings.some((finding) => finding.severity === "block")) return "block";
  return findings.some((finding) => finding.severity === "warn") ? "warn" : "allow";
}
