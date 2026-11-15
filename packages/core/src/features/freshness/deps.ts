import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadRegistryConfig } from "../../infra/http/registry-config.js";
import { errorMessage } from "../../shared/errors.js";
import { assessUpgrade } from "../impact/assess.js";
import {
  fetchPackageTimeline,
  queryOutdatedPackages,
  type NpmRegistryPackageInfo,
  type PackageTimeline,
} from "../intelligence/sources/registry.js";
import type { FreshnessStep, StepAssessment } from "./types.js";

export interface DirectDependency {
  name: string;
  field: FreshnessStep["field"];
  range: string;
}

/** What the freshness operations need from outside: the package manager, the registry, the clock. */
export interface FreshnessDeps {
  /** Direct dependencies that come from a registry (not workspace, file, link or git ranges). */
  readDirect(cwd: string): DirectDependency[];
  isInstalled(cwd: string, name: string): boolean;
  /** Packages whose installed version is older than the registry's latest. */
  queryOutdated(
    cwd: string,
    options: { packageManager?: string },
  ): Promise<Map<string, NpmRegistryPackageInfo>>;
  fetchTimeline(name: string, cwd: string): Promise<PackageTimeline | undefined>;
  assess(name: string, from: string, to: string, cwd: string): Promise<StepAssessment>;
  now(): number;
  /** How many registry or tarball requests run at once. */
  concurrency: number;
}

const NOT_FROM_REGISTRY =
  /^(workspace|file|link|portal|patch|npm|git|git\+[a-z]+|github|gitlab|bitbucket|https?):/i;

export function readDirectDependencies(cwd: string): DirectDependency[] {
  let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as typeof manifest;
  } catch (error) {
    throw new Error(`Cannot read package.json in ${cwd}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const found = new Map<string, DirectDependency>();
  for (const field of ["devDependencies", "dependencies"] as const) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range === "string" && !NOT_FROM_REGISTRY.test(range)) {
        found.set(name, { name, field, range });
      }
    }
  }
  return [...found.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

export const defaultFreshnessDeps: FreshnessDeps = {
  readDirect: readDirectDependencies,
  isInstalled: (cwd, name) => existsSync(join(cwd, "node_modules", name, "package.json")),
  queryOutdated: (cwd, options) => queryOutdatedPackages(cwd, options),
  fetchTimeline: (name, cwd) => fetchPackageTimeline(name, loadRegistryConfig(cwd)),
  async assess(name, from, to, cwd) {
    try {
      const result = await assessUpgrade(name, from, to, { cwd });
      return { breakability: result.breakability, score: result.score, summary: result.summary };
    } catch (error) {
      return {
        breakability: "Unknown",
        summary: `could not assess ${name} ${from} -> ${to}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      };
    }
  },
  now: () => Date.now(),
  concurrency: 4,
};

/** Run `task` over `items`, at most `limit` at a time, keeping the order of the results. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
