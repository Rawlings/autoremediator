/**
 * Turning the registry's packument for a package into the committed corpus file: the same published
 * data, limited to versions published by the snapshot date, without the fields that only describe
 * people (`maintainers`, `_npmUser`) or are large and unused (`readme`).
 */
import semver from "semver";
import { z } from "zod";

const DROPPED_VERSION_FIELDS = [
  "readme",
  "readmeFilename",
  "_npmUser",
  "_npmOperationalInternal",
  "_nodeVersion",
  "_npmVersion",
  "maintainers",
  "contributors",
  "users",
];

const packumentSchema = z
  .object({
    name: z.string(),
    "dist-tags": z.record(z.string(), z.string()).default({}),
    versions: z.record(z.string(), z.record(z.string(), z.unknown())),
    time: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();

export type Packument = z.infer<typeof packumentSchema>;

export function parsePackument(raw: unknown): Packument {
  return packumentSchema.parse(raw);
}

/** Versions published at or before `snapshotDate`, oldest first. */
export function versionsAsOf(packument: Packument, snapshotDate: string): string[] {
  const cutoff = Date.parse(snapshotDate);
  return Object.keys(packument.versions)
    .filter((version) => semver.valid(version) !== null)
    .filter((version) => {
      const published = packument.time[version];
      return published !== undefined && Date.parse(published) <= cutoff;
    })
    .toSorted((a, b) => semver.compare(a, b));
}

/** The committed form of a packument: real manifests for `keep` versions only. */
export function trimPackument(
  packument: Packument,
  keep: readonly string[],
  snapshotDate: string,
): Record<string, unknown> {
  const kept = new Set(keep);
  const versions: Record<string, unknown> = {};
  const time: Record<string, string> = {};
  for (const version of keep) {
    const manifest = { ...packument.versions[version] };
    for (const field of DROPPED_VERSION_FIELDS) delete manifest[field];
    const dist = z.record(z.string(), z.unknown()).parse(manifest["dist"]);
    manifest["dist"] = {
      tarball: dist["tarball"],
      integrity: dist["integrity"],
      shasum: dist["shasum"],
      ...(dist["fileCount"] === undefined ? {} : { fileCount: dist["fileCount"] }),
      ...(dist["unpackedSize"] === undefined ? {} : { unpackedSize: dist["unpackedSize"] }),
    };
    versions[version] = manifest;
    const published = packument.time[version];
    if (published !== undefined) time[version] = published;
  }
  const tags = Object.fromEntries(
    Object.entries(packument["dist-tags"]).filter(([, version]) => kept.has(version)),
  );
  if (tags["latest"] === undefined) {
    const stable = keep.filter((version) => semver.prerelease(version) === null);
    const newest = stable.at(-1) ?? keep.at(-1);
    if (newest !== undefined) tags["latest"] = newest;
  }
  const stamps = Object.values(time).toSorted();
  return {
    name: packument.name,
    snapshotDate,
    "dist-tags": tags,
    versions,
    time: { created: stamps[0], modified: stamps.at(-1), ...time },
  };
}
