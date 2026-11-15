import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { findOccurrences, type LockGraph } from "../../scanner/lock-graph/index.js";
import { scanSecrets, type SecretsChecklist } from "../incident/ci-secrets.js";
import { installScriptOf, loadProjectLocks, type ProjectLock } from "../incident/project.js";
import { renderPlaybook, renderPremortemSummary } from "./playbook.js";
import type {
  PackageBlastRadius,
  PremortemOptions,
  PremortemReport,
  PremortemRepo,
  PremortemTarget,
  PremortemUsage,
} from "./types.js";

export type {
  PackageBlastRadius,
  PlaybookKind,
  PremortemOptions,
  PremortemReport,
  PremortemRepo,
  PremortemTarget,
  PremortemUsage,
} from "./types.js";

/** Repositories under `root`: a directory with `.git` and `package.json`. Symlinks are not followed. */
export function discoverRepos(
  root: string,
  options: { maxDepth?: number; max?: number } = {},
): PremortemTarget[] {
  const maxDepth = options.maxDepth ?? 3;
  const max = options.max ?? 200;
  const found: PremortemTarget[] = [];
  const visit = (dir: string, depth: number): void => {
    if (found.length >= max) return;
    if (existsSync(join(dir, ".git")) && existsSync(join(dir, "package.json"))) {
      found.push({ cwd: dir, label: relative(root, dir) || basename(dir) });
      return;
    }
    if (depth >= maxDepth) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.toSorted()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const child = join(dir, name);
      try {
        if (lstatSync(child).isDirectory()) visit(child, depth + 1);
      } catch {
        // Unreadable entries are skipped.
      }
    }
  };
  visit(root, 0);
  return found;
}

interface RepoScan {
  repo: PremortemRepo;
  locks: ProjectLock[];
  secrets: SecretsChecklist;
}

function scanRepo(target: PremortemTarget): RepoScan {
  const cwd = resolve(target.cwd);
  const { locks, notes } = loadProjectLocks(cwd);
  const secrets = scanSecrets(cwd);
  const installing = secrets.ci.filter((file) => file.installs || file.installJobs.length > 0);
  const containers = secrets.containers.filter((file) => file.installs);
  const secretNames = [
    ...installing.flatMap((file) => [...file.secretNames, ...file.envNames]),
    ...containers.flatMap((file) => [...file.names, ...file.secretMounts]),
    ...secrets.npmrc.flatMap((file) => file.envNames),
  ];
  const biggest = Math.max(0, ...locks.map((lock) => lock.graph.nodes.size));
  return {
    locks,
    secrets,
    repo: {
      label: target.label ?? basename(cwd),
      cwd,
      lockfiles: locks.map((lock) => lock.path),
      packageCount: biggest,
      ci: {
        installs: installing.length > 0 || containers.length > 0,
        secretNames: [...new Set(secretNames)].toSorted(),
        files: [
          ...installing.map((file) => file.file),
          ...containers.map((file) => file.file),
        ].toSorted(),
      },
      notes:
        locks.length === 0
          ? ["no lockfile could be read, so nothing could be assessed here", ...notes]
          : notes,
    },
  };
}

interface Aggregate {
  repos: Set<string>;
  dependents: Set<string>;
  privileged: boolean;
}

function aggregate(
  scans: RepoScan[],
  rankBy: "depended-upon" | "privileged",
): Map<string, Aggregate> {
  const byName = new Map<string, Aggregate>();
  for (const scan of scans) {
    for (const { graph } of scan.locks) {
      const parents = reverseEdges(graph);
      for (const node of graph.nodes.values()) {
        const entry = byName.get(node.name) ?? {
          repos: new Set<string>(),
          dependents: new Set<string>(),
          privileged: false,
        };
        entry.repos.add(scan.repo.label);
        for (const parent of parents.get(node.id) ?? [])
          entry.dependents.add(graph.nodes.get(parent)?.name ?? parent);
        if (node.installScript) entry.privileged = true;
        else if (
          rankBy === "privileged" &&
          !graph.recordsInstallScripts &&
          installScriptOf(scan.repo.cwd, node.name, node.version, undefined) === true
        ) {
          entry.privileged = true;
        }
        byName.set(node.name, entry);
      }
    }
  }
  return byName;
}

function reverseEdges(graph: LockGraph): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    for (const dep of node.deps) {
      const list = parents.get(dep) ?? [];
      list.push(node.id);
      parents.set(dep, list);
    }
  }
  return parents;
}

const slug = (value: string): string => {
  const clean =
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 60) || "item";
  return `${clean}-${createHash("sha256").update(value).digest("hex").slice(0, 6)}`;
};

/**
 * "What if this package is compromised tomorrow?" across several repositories: which of them lock
 * it, directly or not, in which versions, whether it runs install scripts, and whether CI installs
 * run with secrets in reach. Reads checkouts only (lockfiles, CI files, installed manifests); no
 * network. With `outputDir`, writes a playbook per repository or per package with the exact
 * commands to run on the day, which is meant to be committed.
 */
export async function premortem(options: PremortemOptions): Promise<PremortemReport> {
  const notes: string[] = [];
  let targets = options.targets ?? [];
  if (options.root) targets = [...targets, ...discoverRepos(resolve(options.root))];
  if (targets.length === 0) {
    throw new Error(
      options.root
        ? `No repository (a .git next to a package.json) found under ${options.root}.`
        : "Name the repositories: targets, or a root to search.",
    );
  }
  for (const target of targets) {
    if (!target.cwd || !existsSync(target.cwd) || !statSync(target.cwd).isDirectory()) {
      throw new Error(`Target ${JSON.stringify(target.label ?? target.cwd)} is not a directory.`);
    }
  }
  // The same checkout named twice would double its weight.
  const paths = new Set<string>();
  const labels = new Set<string>();
  const labelled: PremortemTarget[] = [];
  for (const target of targets) {
    const path = resolve(target.cwd);
    if (paths.has(path)) continue;
    paths.add(path);
    const wanted = target.label ?? basename(path);
    let label = wanted;
    for (let n = 2; labels.has(label); n += 1) label = `${wanted}-${n}`;
    labels.add(label);
    labelled.push({ cwd: target.cwd, label });
  }

  const scans = labelled.map((target) => scanRepo(target));
  const rankBy = options.rankBy ?? "depended-upon";
  const stats = aggregate(scans, rankBy);

  let names: string[];
  let selection: PremortemReport["selection"];
  if (options.packages && options.packages.length > 0) {
    names = [...new Set(options.packages)];
    selection = { mode: "given" };
  } else {
    const top = options.top ?? 10;
    names = [...stats.entries()]
      .toSorted(([nameA, a], [nameB, b]) => {
        const privilege = Number(b.privileged) - Number(a.privileged);
        const reach = b.repos.size - a.repos.size || b.dependents.size - a.dependents.size;
        return (
          (rankBy === "privileged" ? privilege || reach : reach || privilege) ||
          nameA.localeCompare(nameB)
        );
      })
      .slice(0, top)
      .map(([name]) => name);
    selection = { mode: "ranked", rankBy, top };
  }

  const packages: PackageBlastRadius[] = names.map((packageName) => {
    const usage: PremortemUsage[] = [];
    const dependents = new Set<string>();
    let privileged: boolean | "unknown" = false;
    for (const scan of scans) {
      const found = scan.locks.flatMap(({ graph }) => {
        const hits = findOccurrences(graph, (name) => name === packageName);
        const parents = reverseEdges(graph);
        for (const occurrence of hits) {
          for (const parent of parents.get(occurrence.nodeId) ?? [])
            dependents.add(graph.nodes.get(parent)?.name ?? parent);
        }
        return hits;
      });
      if (found.length === 0) continue;
      const scripts = new Set(
        found.map((entry) =>
          installScriptOf(scan.repo.cwd, entry.name, entry.version, entry.installScript),
        ),
      );
      if (scripts.has(true)) privileged = true;
      else if (scripts.has("unknown") && privileged === false) privileged = "unknown";
      const scopes = new Set(found.map((entry) => entry.scope));
      usage.push({
        repo: scan.repo.label,
        versions: [...new Set(found.map((entry) => entry.version))].toSorted(),
        direct: found.some((entry) => entry.direct),
        scope: scopes.has("production")
          ? "production"
          : scopes.has("development")
            ? "development"
            : "unreferenced",
        installScript: scripts.has(true) ? true : scripts.has("unknown") ? "unknown" : false,
      });
    }
    return {
      packageName,
      repoCount: usage.length,
      dependentCount: dependents.size,
      installScript: privileged,
      usage,
      reposWithCiSecrets: usage
        .map((entry) => entry.repo)
        .filter((label) => {
          const repo = scans.find((scan) => scan.repo.label === label)?.repo;
          return Boolean(repo?.ci.installs && repo.ci.secretNames.length > 0);
        }),
    };
  });
  if (selection.mode === "given") {
    for (const entry of packages.filter((candidate) => candidate.repoCount === 0)) {
      notes.push(
        `${entry.packageName} is not locked in any of the ${scans.length} repositories read.`,
      );
    }
  }
  for (const scan of scans) {
    for (const note of scan.repo.notes) notes.push(`${scan.repo.label}: ${note}`);
  }

  const report: PremortemReport = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    repos: scans.map((scan) => scan.repo),
    packages,
    selection,
    notes,
  };

  if (options.outputDir) {
    const dir = resolve(options.outputDir);
    const playbookDir = join(dir, "playbooks");
    mkdirSync(playbookDir, { recursive: true });
    const files: string[] = [];
    const write = (path: string, text: string): void => {
      writeFileSync(path, text, "utf8");
      files.push(path);
    };
    const kind = options.playbooks ?? "repo";
    const subjects =
      kind === "repo"
        ? report.repos.map((repo) => repo.label)
        : report.packages.map((entry) => entry.packageName);
    for (const subject of subjects) {
      write(join(playbookDir, `${slug(subject)}.md`), renderPlaybook(report, kind, subject));
    }
    write(
      join(dir, "premortem.md"),
      renderPremortemSummary(report, kind, (subject) => `playbooks/${slug(subject)}.md`),
    );
    write(join(dir, "premortem.json"), `${JSON.stringify(report, null, 2)}\n`);
    report.files = files;
    // The JSON on disk is written before `files` is known; rewrite it so it lists itself.
    writeFileSync(join(dir, "premortem.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}
