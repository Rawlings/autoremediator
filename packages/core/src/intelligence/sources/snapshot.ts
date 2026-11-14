/**
 * Offline intelligence snapshots.
 *
 * A snapshot is a JSON object keyed by CVE ID (optionally nested under a top-level `cves` key).
 * Each entry is either a complete {@link CveDetails} record or a compact single-package
 * shorthand. Entries are validated on read, so malformed data fails loudly instead of
 * silently producing empty or partial remediation results.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { CveDetails } from "../../platform/types.js";

const severity = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]);

const kev = z.object({
  knownExploited: z.boolean(),
  dateAdded: z.string().optional(),
  dueDate: z.string().optional(),
  requiredAction: z.string().optional(),
  knownRansomwareCampaignUse: z.string().optional(),
});

const epss = z.object({
  score: z.number().min(0).max(1),
  percentile: z.number().min(0).max(1).optional(),
  date: z.string().optional(),
});

const affectedPackage = z.object({
  name: z.string().min(1),
  ecosystem: z.literal("npm").default("npm"),
  vulnerableRange: z.string().min(1, "vulnerableRange must not be empty"),
  firstPatchedVersion: z.string().optional(),
  /** Provenance of the recorded data; defaults to the snapshot itself. */
  source: z.enum(["osv", "github-advisory", "offline-snapshot"]).default("offline-snapshot"),
});

const fullEntry = z.object({
  id: z.string().min(1),
  summary: z.string(),
  severity,
  cvssScore: z.number().optional(),
  publishedAt: z.string().optional(),
  epss: epss.optional(),
  kev: kev.optional(),
  references: z.array(z.string()).default([]),
  affectedPackages: z.array(affectedPackage).min(1),
});

/** Compact form for hand-written snapshots: one affected package, flat exploit signals. */
const shorthandEntry = z.object({
  packageName: z.string().min(1),
  vulnerableRange: z.string().min(1, "vulnerableRange must not be empty"),
  firstPatchedVersion: z.string().optional(),
  summary: z.string().optional(),
  severity: severity.default("UNKNOWN"),
  cvssScore: z.number().optional(),
  epssScore: z.number().min(0).max(1).optional(),
  cisaKev: z.boolean().optional(),
});

export type IntelligenceSnapshot = Readonly<Record<string, unknown>>;

export function loadIntelligenceSnapshot(filePath: string): IntelligenceSnapshot {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Intelligence snapshot at ${filePath} must be a JSON object keyed by CVE ID.`);
  }
  return parsed as IntelligenceSnapshot;
}

function entries(snapshot: IntelligenceSnapshot): Record<string, unknown> {
  const nested = snapshot.cves;
  return typeof nested === "object" && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : (snapshot as Record<string, unknown>);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(entry)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Look up a CVE (case-insensitive ID). Returns `null` when the snapshot has no entry,
 * and throws when an entry exists but is malformed.
 */
export function lookupSnapshotCve(
  snapshot: IntelligenceSnapshot,
  cveId: string,
): CveDetails | null {
  const normalizedId = cveId.toUpperCase();
  const store = entries(snapshot);
  const raw = Object.entries(store).find(([key]) => key.toUpperCase() === normalizedId)?.[1];
  if (raw === undefined) return null;

  const full = fullEntry.safeParse(raw);
  if (full.success) return full.data;

  const short = shorthandEntry.safeParse(raw);
  if (short.success) {
    const {
      packageName,
      vulnerableRange,
      firstPatchedVersion,
      epssScore,
      cisaKev,
      summary,
      ...rest
    } = short.data;
    return {
      ...rest,
      id: normalizedId,
      summary: summary ?? `Offline intelligence entry for ${normalizedId}`,
      references: [],
      affectedPackages: [
        {
          name: packageName,
          ecosystem: "npm",
          vulnerableRange,
          firstPatchedVersion,
          source: "offline-snapshot",
        },
      ],
      epss: epssScore === undefined ? undefined : { score: epssScore },
      kev: cisaKev === undefined ? undefined : { knownExploited: cisaKev },
    };
  }

  const issues = "affectedPackages" in (raw as object) ? full.error : short.error;
  throw new Error(
    `Invalid intelligence snapshot entry for ${normalizedId}: ${describeIssues(issues)}`,
  );
}
