import semver from "semver";

import { fetchOsvVuln, parseOsvVuln } from "../../intelligence/sources/osv.js";
import type { AdvisoryAffected, AdvisoryLookup } from "./types.js";

interface OsvRecord {
  details?: string;
  database_specific?: { cwe_ids?: unknown };
}

/**
 * The advisory text the agent reads: OSV's summary, its long description, the CWE ids and the
 * reference links. Returns undefined when OSV does not know the id.
 */
export async function lookupAdvisoryOsv(id: string): Promise<AdvisoryLookup | undefined> {
  const vuln = await fetchOsvVuln(id);
  if (!vuln) return undefined;
  const parsed = parseOsvVuln(vuln);
  const raw = vuln as unknown as OsvRecord;
  const affected: AdvisoryAffected[] = [];
  for (const entry of parsed.affectedPackages) {
    const item: AdvisoryAffected = { name: entry.name, vulnerableRange: entry.vulnerableRange };
    if (entry.firstPatchedVersion) item.firstPatchedVersion = entry.firstPatchedVersion;
    affected.push(item);
  }
  const cwes = Array.isArray(raw.database_specific?.cwe_ids)
    ? raw.database_specific.cwe_ids.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    context: {
      id: parsed.id,
      summary: parsed.summary,
      ...(raw.details ? { details: raw.details } : {}),
      cwes,
      references: parsed.references,
      source: "osv",
    },
    affected,
  };
}

export interface VersionChoice {
  vulnerableVersion: string;
  fixedVersion: string;
}

const stable = (version: string): boolean =>
  semver.valid(version) !== null && semver.prerelease(version) === null;

/**
 * The pair of versions to prove against. Explicit versions win. Otherwise the fixed version is the
 * advisory's first patched version and the vulnerable one is the newest published stable version
 * inside the vulnerable range below it, which keeps the difference between the two as small as the
 * advisory allows.
 */
export function chooseVersions(input: {
  packageName: string;
  affected: readonly AdvisoryAffected[];
  published: readonly string[];
  vulnerableVersion?: string;
  fixedVersion?: string;
}): VersionChoice {
  const entries = input.affected.filter((entry) => entry.name === input.packageName);
  const fixedVersion =
    input.fixedVersion ?? entries.find((entry) => entry.firstPatchedVersion)?.firstPatchedVersion;
  if (!fixedVersion || semver.valid(fixedVersion) === null) {
    throw new Error(
      `The advisory does not name a fixed version of ${input.packageName}. Pass fixedVersion.`,
    );
  }

  let vulnerableVersion = input.vulnerableVersion;
  if (!vulnerableVersion) {
    const inRange = input.published
      .filter(stable)
      .filter((version) => semver.lt(version, fixedVersion))
      .filter((version) =>
        entries.length === 0
          ? true
          : entries.some((entry) => semver.satisfies(version, entry.vulnerableRange)),
      )
      .toSorted(semver.rcompare);
    vulnerableVersion = inRange[0];
    if (!vulnerableVersion) {
      throw new Error(
        `No published version of ${input.packageName} below ${fixedVersion} is in the advisory's vulnerable range. Pass vulnerableVersion.`,
      );
    }
  }
  if (semver.valid(vulnerableVersion) === null) {
    throw new Error(`vulnerableVersion must be an exact version, not "${vulnerableVersion}".`);
  }
  if (!semver.lt(vulnerableVersion, fixedVersion)) {
    throw new Error(
      `The vulnerable version (${vulnerableVersion}) must be older than the fixed version (${fixedVersion}).`,
    );
  }
  return { vulnerableVersion, fixedVersion };
}

/** Pick the package when the caller did not name one, if the advisory affects exactly one. */
export function choosePackage(
  requested: string | undefined,
  affected: readonly AdvisoryAffected[],
): string {
  if (requested) return requested;
  const names = [...new Set(affected.map((entry) => entry.name))];
  if (names.length === 1) return names[0]!;
  throw new Error(
    names.length === 0
      ? "The advisory names no npm package. Pass package."
      : `The advisory affects several packages (${names.join(", ")}). Pass package.`,
  );
}
