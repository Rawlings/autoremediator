import semver from "semver";

import {
  lookupCveGitHub,
  mergeGhDataIntoCveDetails,
} from "../../intelligence/sources/github-advisory.js";
import { lookupCveOsv } from "../../intelligence/sources/osv.js";
import {
  loadIntelligenceSnapshot,
  lookupSnapshotCve,
} from "../../intelligence/sources/snapshot.js";
import type { CveDetails } from "../../platform/types.js";
import { parsePackageSpec } from "../guard/spec.js";
import type { AffectedRange, IncidentTarget } from "./types.js";

/** Advisory ids the lookups understand. `MAL-` ids are OSV's malicious-package reports. */
const ADVISORY_ID =
  /^(?:MAL-\d{4}-\d+|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|CVE-\d{4}-\d{4,7}|OSV-\d{4}-\d+)$/i;

export const isAdvisoryId = (value: string): boolean => ADVISORY_ID.test(value.trim());

/** Advisory feeds write ranges as `>= 1.0.0, < 1.2.0`; semver wants spaces. */
export function normalizeRange(range: string): string | undefined {
  const cleaned = range.replaceAll(",", " ").replaceAll(/\s+/g, " ").trim();
  return cleaned !== "" && semver.validRange(cleaned) !== null ? cleaned : undefined;
}

/** Lookups an advisory id needs; replaceable so tests and embedders need no network. */
export interface TargetDeps {
  lookupOsv(id: string): Promise<CveDetails | null>;
  lookupGitHub: typeof lookupCveGitHub;
}

export const defaultTargetDeps: TargetDeps = {
  lookupOsv: lookupCveOsv,
  lookupGitHub: lookupCveGitHub,
};

/** Turn what the user typed into the packages and version ranges that are bad. */
export async function resolveTarget(
  input: string,
  options: { offline?: boolean; intelligenceSnapshotPath?: string },
  deps: TargetDeps = defaultTargetDeps,
): Promise<IncidentTarget> {
  const typed = input.trim();
  if (typed === "")
    throw new Error(
      "Name what was compromised: an advisory id (MAL-…, GHSA-…, CVE-…) or package@range.",
    );

  if (!isAdvisoryId(typed)) {
    const parsed = parsePackageSpec(typed);
    if (parsed.kind !== "registry") {
      throw new Error(
        parsed.kind === "invalid"
          ? `"${typed.slice(0, 80)}" is neither an advisory id nor a package spec (${parsed.reason}).`
          : `"${typed.slice(0, 80)}" is not a registry package spec.`,
      );
    }
    if (!parsed.range) {
      throw new Error(
        `Say which versions of ${parsed.name} are bad: "${parsed.name}@1.2.3" or "${parsed.name}@>=1.2.0 <1.2.5" (quote it in the shell).`,
      );
    }
    const range = normalizeRange(parsed.range);
    if (!range)
      throw new Error(`"${parsed.range}" is not a valid semver range for ${parsed.name}.`);
    return { input: typed, kind: "package-range", affected: [{ name: parsed.name, range }] };
  }

  const id = typed.toUpperCase();
  let details: CveDetails | null;
  let source: NonNullable<IncidentTarget["advisory"]>["source"];
  if (options.offline) {
    if (!options.intelligenceSnapshotPath) {
      throw new Error(
        `${id} cannot be looked up offline without an intelligence snapshot. Pass the snapshot, or name the package and versions directly (package@range), which needs no lookup.`,
      );
    }
    details = lookupSnapshotCve(loadIntelligenceSnapshot(options.intelligenceSnapshotPath), id);
    source = "offline-snapshot";
  } else {
    const [osv, github] = await Promise.all([
      deps.lookupOsv(id),
      deps.lookupGitHub(id).catch(() => []),
    ]);
    details =
      osv ??
      (github.length > 0
        ? {
            id,
            summary: "Details from the GitHub Advisory Database.",
            severity: "UNKNOWN",
            references: [],
            affectedPackages: [],
          }
        : null);
    if (details && github.length > 0) details = mergeGhDataIntoCveDetails(details, github);
    source = osv ? "osv" : "github-advisory";
  }
  if (!details) {
    throw new Error(
      options.offline
        ? `${id} is not in the intelligence snapshot.`
        : `${id} was not found in OSV or the GitHub advisory database. Check the id, or name the package and versions directly (package@range).`,
    );
  }

  const affected: AffectedRange[] = [];
  for (const entry of details.affectedPackages) {
    if (entry.ecosystem !== "npm") continue;
    const range = normalizeRange(entry.vulnerableRange);
    if (!range) continue;
    const existing = affected.find((candidate) => candidate.name === entry.name);
    // The same package listed twice (two ranges): either range being installed counts.
    if (existing) existing.range = `${existing.range} || ${range}`;
    else
      affected.push({
        name: entry.name,
        range,
        ...(entry.firstPatchedVersion ? { firstPatchedVersion: entry.firstPatchedVersion } : {}),
      });
  }
  if (affected.length === 0) {
    throw new Error(
      `${id} names no npm package with a usable version range, so there is nothing to look for. Give the package and versions yourself (package@range).`,
    );
  }
  return {
    input: typed,
    kind: "advisory",
    advisory: {
      id,
      summary: details.summary.slice(0, 500),
      source,
      references: details.references.slice(0, 10),
    },
    affected,
  };
}
