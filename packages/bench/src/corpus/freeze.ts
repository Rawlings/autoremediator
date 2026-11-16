/**
 * Deriving a task's offline intelligence snapshot (`intel.json`) from its published OSV record. The file
 * is generated, never hand-written: `intelIsCurrent` lets a test fail if it differs from what the
 * record produces, so a task cannot quietly carry a different advisory than the one it cites.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";
import { z } from "zod";

import {
  assertAdmissible,
  fixedVersionsOf,
  osvSchema,
  severityOf,
  vulnerableRangeOf,
  type OsvRecord,
} from "./osv.ts";
import { ADVISORY_DIR } from "./paths.ts";

const taskFileSchema = z
  .object({ advisory: z.string(), package: z.string(), osv: z.string() })
  .passthrough();

export function readAdvisory(osvId: string, dir: string = ADVISORY_DIR): OsvRecord {
  const path = join(dir, `${osvId}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `No stored advisory ${osvId}: run \`pnpm bench:corpus advisory ${osvId} --package <name>\``,
    );
  }
  return osvSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** The snapshot entry the product reads, from a published record. */
export function snapshotEntryOf(record: OsvRecord, requestedId: string, packageName: string) {
  assertAdmissible(record, packageName);
  if (record.id !== requestedId && !record.aliases.includes(requestedId)) {
    throw new Error(
      `${record.id} is not known as ${requestedId} (aliases: ${record.aliases.join(", ") || "none"})`,
    );
  }
  const fixed = fixedVersionsOf(record, packageName).toSorted((a, b) => semver.compare(a, b));
  return {
    id: requestedId,
    summary: record.summary ?? record.id,
    severity: severityOf(record),
    ...(record.published ? { publishedAt: record.published } : {}),
    references: record.references.map((reference) => reference.url),
    affectedPackages: [
      {
        name: packageName,
        ecosystem: "npm",
        vulnerableRange: vulnerableRangeOf(record, packageName),
        ...(fixed[0] ? { firstPatchedVersion: fixed[0] } : {}),
        source: "osv",
      },
    ],
  };
}

function expectedIntel(taskDir: string, advisoryDir?: string): string {
  const task = taskFileSchema.parse(JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")));
  const record = readAdvisory(task.osv, advisoryDir);
  const entry = snapshotEntryOf(record, task.advisory, task.package);
  return `${JSON.stringify({ [task.advisory]: entry }, null, 2)}\n`;
}

export function freezeTask(taskDir: string, advisoryDir?: string): void {
  writeFileSync(join(taskDir, "intel.json"), expectedIntel(taskDir, advisoryDir));
}

export function intelIsCurrent(taskDir: string, advisoryDir?: string): boolean {
  const path = join(taskDir, "intel.json");
  return existsSync(path) && readFileSync(path, "utf8") === expectedIntel(taskDir, advisoryDir);
}
