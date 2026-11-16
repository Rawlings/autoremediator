import semver from "semver";

export function newestCompatible(range: string, versions: string[]): string | null {
  return semver.maxSatisfying(versions, range);
}

export function nextVersion(version: string, level: "major" | "minor" | "patch"): string | null {
  return semver.inc(version, level);
}

export function isUpgrade(from: string, to: string): boolean {
  return semver.gt(to, from);
}
