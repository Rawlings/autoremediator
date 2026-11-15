/** An in-memory registry for radar tests: packages, versions, files, changelogs. No network. */
import type { AssessUpgradeResult } from "../../impact/assess.js";
import type {
  ByteBudget,
  InstalledPackage,
  RadarDeps,
  RadarPackage,
  RegistryVersions,
} from "../types.js";

export interface WorldVersion {
  files?: Record<string, string>;
  docs?: Record<string, string>;
  deprecated?: string;
  publishedAt?: string;
  repository?: string;
  /** Bytes to charge the budget when this version is downloaded. */
  size?: number;
}

export interface WorldPackage {
  versions: Record<string, WorldVersion>;
  latest?: string;
  /** Advisories OSV would return for the installed version. */
  advisories?: Array<{ id: string; fixedIn?: string }>;
}

export type World = Record<string, WorldPackage>;

export interface Spy {
  loaded: string[];
  advisoryQueries: string[];
  githubCalls: string[];
  assessed: string[];
}

export function makeDeps(
  world: World,
  installed: InstalledPackage[],
  overrides: Partial<RadarDeps> = {},
): { deps: RadarDeps; spy: Spy } {
  const spy: Spy = { loaded: [], advisoryQueries: [], githubCalls: [], assessed: [] };
  const deps: RadarDeps = {
    listInstalled: () => installed,
    async fetchVersions(name, _cwd, budget: ByteBudget): Promise<RegistryVersions | undefined> {
      const entry = world[name];
      if (!entry) return undefined;
      budget.charge(1000);
      return {
        versions: Object.entries(entry.versions).map(([version, value]) =>
          Object.assign(
            { version },
            value.deprecated ? { deprecated: value.deprecated } : {},
            value.publishedAt ? { publishedAt: value.publishedAt } : {},
          ),
        ),
        latest: entry.latest ?? Object.keys(entry.versions).at(-1),
        bytes: 1000,
      };
    },
    async loadPackage(name, version, _cwd, budget): Promise<RadarPackage> {
      budget.assertRoom(`${name}@${version}`);
      const entry = world[name]?.versions[version];
      if (!entry) throw new Error(`${name}@${version} was not found on the registry`);
      spy.loaded.push(`${name}@${version}`);
      budget.charge(entry.size ?? 5000);
      return {
        name,
        version,
        files: new Map(Object.entries(entry.files ?? {})),
        docs: new Map(Object.entries(entry.docs ?? {})),
        manifest: { name, version, ...(entry.repository ? { repository: entry.repository } : {}) },
        integrityVerified: true,
      };
    },
    async queryAdvisories(name) {
      spy.advisoryQueries.push(name);
      return world[name]?.advisories ?? [];
    },
    async fetchGithubReleases(repository) {
      spy.githubCalls.push(`${repository.owner}/${repository.repo}`);
      return { releases: [] };
    },
    async assess(name, from, to): Promise<AssessUpgradeResult> {
      spy.assessed.push(`${name}@${from}->${to}`);
      return {
        packageName: name,
        fromVersion: from,
        toVersion: to,
        breakability: "Low",
        score: 0,
        summary: "No project code reaches a changed export.",
        findings: [],
        unreachedChanges: { breaking: 0, possiblyBreaking: 0 },
        usage: { filesScanned: 1, filesUsingPackage: 1, specifiers: [name] },
        surface: { source: "js", entryPointsCompared: 1, apiChanges: 0 },
        limitations: [],
        scoring: { points: {} as never, mediumThreshold: 15, rule: "" },
      } as AssessUpgradeResult;
    },
    ...overrides,
  };
  return { deps, spy };
}

export const direct = (name: string, version: string): InstalledPackage => ({
  name,
  version,
  direct: true,
  scope: "production",
});

export const transitive = (name: string, version: string): InstalledPackage => ({
  name,
  version,
  direct: false,
  scope: "production",
});

export const VULNERABLE_SET =
  "module.exports = function set(o, key, value) {\n  o[key] = value;\n};\n";
export const GUARDED_SET =
  "module.exports = function set(o, key, value) {\n  if (key === '__proto__' || key === 'constructor') return;\n  o[key] = value;\n};\n";

export const SECURITY_CHANGELOG =
  "# Changelog\n\n## 1.0.1\n- Fixed prototype pollution in `set` (reported privately).\n\n## 1.0.0\n- First release.\n";
