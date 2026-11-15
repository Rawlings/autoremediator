export type PlaybookKind = "repo" | "package";

export interface PremortemTarget {
  /** Repository checkout to read. */
  cwd: string;
  /** Display name (default: the directory name). */
  label?: string;
}

export interface PremortemOptions {
  /** Repositories to look at. The portfolio targets-file format works: only `cwd` and `label` are read. */
  targets?: PremortemTarget[];
  /** Instead of `targets`: find the repositories (a `.git` next to a `package.json`) under this directory. */
  root?: string;
  /** Packages to assess. Default: the most depended-upon ones across the repositories. */
  packages?: string[];
  /** With no `packages`: how many to pick (default 10). */
  top?: number;
  /** How to pick them: most `depended-upon` (default), or most `privileged` (those that run install scripts first). */
  rankBy?: "depended-upon" | "privileged";
  /** One playbook per `repo` (default) or per `package`. Only written with `outputDir`. */
  playbooks?: PlaybookKind;
  /** Write `premortem.md`, `premortem.json` and the playbooks into this directory (created if needed). */
  outputDir?: string;
}

export interface PremortemUsage {
  /** The repository's label. */
  repo: string;
  versions: string[];
  direct: boolean;
  scope: "production" | "development" | "unreferenced";
  /** Installing it runs scripts: from the lockfile, else the installed copy, else unknown. */
  installScript: boolean | "unknown";
}

export interface PackageBlastRadius {
  packageName: string;
  /** Repositories (of those read) that have it locked. */
  repoCount: number;
  /** Distinct packages that depend on it, across the repositories. */
  dependentCount: number;
  /** Some copy runs install scripts: true if any does, "unknown" if none is known to and some are unknown. */
  installScript: boolean | "unknown";
  usage: PremortemUsage[];
  /** Repositories where it is locked and CI installs dependencies with secrets in reach. */
  reposWithCiSecrets: string[];
}

export interface PremortemRepo {
  label: string;
  cwd: string;
  lockfiles: string[];
  /** Locked packages. */
  packageCount: number;
  ci: {
    /** A CI workflow or container build installs dependencies. */
    installs: boolean;
    /** Names of secrets in reach of those installs. */
    secretNames: string[];
    files: string[];
  };
  notes: string[];
}

export interface PremortemReport {
  schemaVersion: "1.0";
  generatedAt: string;
  repos: PremortemRepo[];
  packages: PackageBlastRadius[];
  /** How the packages were chosen. */
  selection: { mode: "given" | "ranked"; rankBy?: "depended-upon" | "privileged"; top?: number };
  /** Files written (with `outputDir`). */
  files?: string[];
  notes: string[];
}
