import type { AssessUpgradeResult } from "../../remediation/impact/assess.js";
import type { PackageSource } from "../../remediation/impact/types.js";
import type { PackumentVersion } from "../../remediation/radar/metadata.js";
import type { RadarModelPort } from "../../remediation/radar/model.js";
import type { RadarCategory, RadarConfidence, RadarFlag } from "../../remediation/radar/types.js";

export type { RadarCategory, RadarConfidence, RadarFlag, RadarModelPort };

export type RadarTarget = "latest" | "minor" | "patch";

export interface RadarOptions {
  /** Project root (default: process.cwd()). Its lockfile says what is installed; its `.npmrc` picks the registry. */
  cwd?: string;
  /** Also look at transitive dependencies. Default: direct dependencies only. */
  includeTransitive?: boolean;
  /** Most entries returned, best first. Default 20. */
  limit?: number;
  /** Most packages analysed (direct first). Default 100. */
  maxPackages?: number;
  /** Which release to compare the installed one with. Default `latest`. */
  target?: RadarTarget;
  /** Also read GitHub release notes for packages without a changelog in the tarball (unauthenticated API, rate-limit aware). */
  github?: boolean;
  /** Language model `provider:model-id` that adds a bounded classification. Off when absent. */
  model?: string;
  /** Refuse: radar needs the registry. */
  offline?: boolean;
  /** Packages analysed at once. Default 4. */
  concurrency?: number;
  /** Per-package time limit in milliseconds. Default 120000. */
  packageTimeoutMs?: number;
  /** Most bytes downloaded in total (packuments and tarballs). Default 268435456. */
  maxBytes?: number;
  /** Check each flagged direct dependency's upgrade impact against the project (default true). */
  assess?: boolean;
  /** Provenance of the call; recorded by surfaces. */
  source?: string;
}

export interface RadarAdvisory {
  id: string;
  /** First fixed version OSV lists, when it lists one. */
  fixedIn?: string;
}

export interface RadarImpact {
  rating: string;
  summary: string;
  findings: number;
}

export type RadarScope = "production" | "development" | "unreferenced" | "unknown";

export interface RadarEntry {
  name: string;
  installed: string;
  target: string;
  upgrade: "patch" | "minor" | "major";
  direct: boolean;
  scope: RadarScope;
  /** Stable releases after `installed` up to `target`. */
  releases: string[];
  /** `per-release` when consecutive versions were diffed, `span` when installed and target were diffed once. */
  diff: "per-release" | "span";
  score: number;
  confidence: RadarConfidence;
  breakdown: Record<RadarCategory, number>;
  /**
   * `silent`: OSV lists no advisory fixed in this range. `now-advisory`: one does (see `advisories`).
   * `unchecked`: OSV could not be reached, so it is unknown.
   */
  status: "silent" | "now-advisory" | "unchecked";
  advisories: RadarAdvisory[];
  /** The wording to use: a security-relevant change without a published advisory, never a claim of a vulnerability. */
  statement: string;
  flags: RadarFlag[];
  impact?: RadarImpact;
  notes: string[];
}

export interface RadarSkipped {
  name: string;
  version?: string;
  reason: string;
}

export interface RadarReport {
  schemaVersion: "1.0";
  /** What a flag means and does not mean. */
  disclaimer: string;
  target: RadarTarget;
  includeTransitive: boolean;
  /** Packages whose releases were compared. */
  analysed: number;
  /** Packages already at the target. */
  upToDate: number;
  /** Analysed packages with nothing above the reporting threshold. */
  clean: number;
  /** Packages scoring at least `weak`; `entries` holds the best `limit` of them. */
  flagged: number;
  entries: RadarEntry[];
  skipped: RadarSkipped[];
  notes: string[];
  bytesDownloaded: number;
  model?: { used: boolean; spec?: string };
  scoring: {
    points: unknown;
    caps: Record<RadarCategory, number>;
    thresholds: { likely: number; possible: number; weak: number };
    rule: string;
  };
}

export interface InstalledPackage {
  name: string;
  version: string;
  direct: boolean;
  scope: RadarScope;
}

export interface RegistryVersions {
  /** Stable (non-prerelease) versions with their deprecation message and publish time. */
  versions: PackumentVersion[];
  latest?: string;
  /** Approximate size of the response, charged to the byte budget. */
  bytes: number;
  /** A note when publish times or deprecations could not be read. */
  note?: string;
}

/** A published version read into memory, with its release-history files. */
export interface RadarPackage extends PackageSource {
  docs: Map<string, string>;
}

export interface GithubRelease {
  tag: string;
  body: string;
}

export interface GithubReleases {
  releases: GithubRelease[];
  /** Why it stopped early, e.g. rate limit; shown as a note. */
  note?: string;
}

/** Counts bytes downloaded and refuses once the cap is spent. */
export interface ByteBudget {
  readonly limit: number;
  used: number;
  charge(bytes: number): void;
  assertRoom(what: string): void;
}

/** Everything radar fetches or reads. Tests replace these; nothing else touches the network or disk. */
export interface RadarDeps {
  listInstalled(cwd: string): InstalledPackage[];
  fetchVersions(
    name: string,
    cwd: string,
    budget: ByteBudget,
  ): Promise<RegistryVersions | undefined>;
  loadPackage(
    name: string,
    version: string,
    cwd: string,
    budget: ByteBudget,
  ): Promise<RadarPackage>;
  queryAdvisories(
    name: string,
    version: string,
  ): Promise<Array<RadarAdvisory & { range?: string }>>;
  fetchGithubReleases(repository: { owner: string; repo: string }): Promise<GithubReleases>;
  assess(
    name: string,
    from: string,
    to: string,
    cwd: string,
    load: (name: string, version: string) => Promise<RadarPackage>,
  ): Promise<AssessUpgradeResult>;
  /** Present only when a model was asked for. */
  model?: RadarModelPort;
}
