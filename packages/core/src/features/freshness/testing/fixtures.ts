import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  NpmRegistryPackageInfo,
  PackageTimeline,
} from "../../intelligence/sources/registry.js";
import type { FreshnessDeps } from "../deps.js";
import type { StepAssessment } from "../types.js";

export const NOW = Date.parse("2026-06-01T00:00:00Z");

export interface FakePackage {
  /** Installed version; leave out for a package that is not installed. */
  installed?: string;
  latest: string;
  versions: string[];
  published?: Record<string, string>;
  field?: "dependencies" | "devDependencies";
  range?: string;
  /** Not reported by `outdated` at all (current). */
  current?: boolean;
}

export const timelineOf = (pkg: FakePackage): PackageTimeline => ({
  versions: pkg.versions,
  deprecated: new Set(),
  published: new Map(Object.entries(pkg.published ?? {})),
});

/** Freshness dependencies backed by a table: no package manager, no registry, a fixed clock. */
export function fakeDeps(
  packages: Record<string, FakePackage>,
  options: {
    assess?: Record<string, StepAssessment>;
    assessed?: string[];
    timelineFails?: string[];
  } = {},
): FreshnessDeps {
  return {
    readDirect: () =>
      Object.entries(packages).map(([name, pkg]) => ({
        name,
        field: pkg.field ?? "dependencies",
        range: pkg.range ?? `^${pkg.installed ?? "1.0.0"}`,
      })),
    isInstalled: (_cwd, name) => packages[name]?.installed !== undefined,
    async queryOutdated() {
      const map = new Map<string, NpmRegistryPackageInfo>();
      for (const [name, pkg] of Object.entries(packages)) {
        if (pkg.current || pkg.installed === undefined) continue;
        map.set(name, {
          currentVersion: pkg.installed,
          wantedVersion: pkg.installed,
          latestVersion: pkg.latest,
          isMajorBump: false,
          dependencyScope: "direct",
        });
      }
      return map;
    },
    async fetchTimeline(name) {
      if (options.timelineFails?.includes(name)) throw new Error("registry exploded");
      const pkg = packages[name];
      return pkg ? timelineOf(pkg) : undefined;
    },
    async assess(name, from, to) {
      options.assessed?.push(`${name} ${from}->${to}`);
      return (
        options.assess?.[name] ?? {
          breakability: "Low",
          score: 0,
          summary: "nothing in the project reaches the changes",
        }
      );
    },
    now: () => NOW,
    concurrency: 2,
  };
}

/** A git project with a manifest and a lockfile, committed, the way the run machinery expects. */
export function makeProject(
  dependencies: Record<string, string>,
  policy?: string,
  extra: Record<string, unknown> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "freshness-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git("init", "-q", "--initial-branch=main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "app", version: "1.0.0", private: true, dependencies, ...extra }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.autoremediator\n");
  if (policy) {
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, ".github", "autoremediator.yml"), policy);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}
