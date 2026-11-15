import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { detectPackageManager } from "../../infra/package-manager/index.js";
import { findWorkspacePackages, findWorkspaceRoot } from "../../infra/package-manager/workspace.js";
import { analyzeDuplicates, dependencyDepths } from "./duplicates.js";
import { readLockfile } from "./lockfile.js";
import { findReplaceable, readNodeRequirement } from "./replaceable.js";
import { emptyUsage, scanPackage, tokensOf, type PackageUsage } from "./scan.js";
import { attackSurface, inspectInstalled } from "./surface.js";
import type {
  AnalyzeDependenciesOptions,
  DependencyDietReport,
  DietPackageReport,
  DuplicatesReport,
} from "./types.js";
import {
  classifyDependencies,
  indexTokens,
  manifestConfigText,
  readManifest,
  scriptTexts,
  SECTIONS,
  type Manifest,
  type TokenIndex,
} from "./unused.js";

interface Target {
  name: string;
  dir: string;
  manifest: Manifest;
}

function declaredNames(manifest: Manifest): string[] {
  return SECTIONS.flatMap((section) => Object.keys(manifest[section] ?? {}));
}

/** Add the manifest's own scripts and tool sections to a package's tokens. */
function addManifestTokens(usage: PackageUsage, manifest: Manifest): void {
  for (const [label, text] of scriptTexts(manifest)) {
    for (const token of tokensOf(text))
      if (!usage.tokens.has(token)) usage.tokens.set(token, label);
  }
  for (const token of tokensOf(manifestConfigText(manifest))) {
    if (!usage.tokens.has(token)) usage.tokens.set(token, "package.json");
  }
}

/**
 * Report what a project could shed: dependencies nothing uses, micro-packages the platform now
 * covers, duplicate installed versions, and a score for how much code the dependency tree adds.
 * Reads the project, its lockfile and its installed packages; changes nothing and needs no network.
 */
export async function analyzeDependencies(
  options: AnalyzeDependenciesOptions = {},
): Promise<DependencyDietReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const rootManifest = readManifest(join(cwd, "package.json"));
  if (!rootManifest)
    throw new Error(`No readable package.json in ${cwd}. Run this in a Node.js project.`);

  const workspaceRoot = findWorkspaceRoot(cwd);
  const root = workspaceRoot ?? cwd;
  const notes: string[] = [];

  // The package at `cwd`, plus every workspace package when `cwd` is the workspace root.
  const targets: Target[] = [{ name: rootManifest.name ?? ".", dir: cwd, manifest: rootManifest }];
  if (workspaceRoot && resolve(workspaceRoot) === cwd) {
    for (const member of findWorkspacePackages(cwd)) {
      targets.push({ name: member.name, dir: member.absoluteDir, manifest: member.manifest });
    }
  }
  const isWorkspace = targets.length > 1;
  const workspaceManifest = workspaceRoot
    ? readManifest(join(workspaceRoot, "package.json"))
    : undefined;

  const interesting = new Set(targets.flatMap((target) => declaredNames(target.manifest)));
  const memberDirectories = new Set(targets.slice(1).map((target) => target.dir));

  const scans = new Map<
    string,
    { usage: PackageUsage; index: TokenIndex; hasTypeScript: boolean; hasTsconfig: boolean }
  >();
  for (const target of targets) {
    const excludeDirectories = target === targets[0] ? memberDirectories : new Set<string>();
    const { usage, files } = scanPackage(
      target.dir,
      interesting,
      { excludeDirectories, gitignoreRoots: [root] },
      emptyUsage(),
    );
    addManifestTokens(usage, target.manifest);
    scans.set(target.dir, {
      usage,
      index: indexTokens(usage.tokens),
      hasTypeScript: files.files.some((file) => /\.(c|m)?tsx?$/.test(file.path)),
      hasTsconfig:
        files.files.some((file) => /^tsconfig[\w.-]*\.json$/.test(file.path)) ||
        existsSync(join(target.dir, "tsconfig.json")),
    });
  }
  const rootScan = scans.get(cwd)!;

  const reports: DietPackageReport[] = [];
  for (const target of targets) {
    const scan = scans.get(target.dir)!;
    const isRootOfWorkspace = isWorkspace && target === targets[0];

    // Other packages of the workspace: the root's dependencies are usually used from a member, and
    // a member is covered by the root's scripts and configuration.
    const elsewhere = isRootOfWorkspace
      ? targets.slice(1).map((member) => ({
          usage: scans.get(member.dir)!.usage,
          index: scans.get(member.dir)!.index,
          packageName: member.name,
        }))
      : isWorkspace
        ? [
            {
              usage: emptyUsage(),
              index: rootScan.index,
              packageName: `${rootManifest.name ?? "the workspace root"} (root scripts and configuration)`,
            },
          ]
        : undefined;

    const classified = classifyDependencies({
      packageDir: target.dir,
      stopAt: root,
      manifest: target.manifest,
      usage: scan.usage,
      index: scan.index,
      ...(elsewhere ? { elsewhere } : {}),
      hasTypeScript:
        scan.hasTypeScript || (isWorkspace && !isRootOfWorkspace && rootScan.hasTypeScript),
      hasTsconfig: scan.hasTsconfig || (isWorkspace && !isRootOfWorkspace && rootScan.hasTsconfig),
    });

    const unusedNames = new Set(
      classified.unused
        .filter((entry) => entry.classification !== "used-indirectly")
        .map((entry) => entry.name),
    );
    const allDeclared = SECTIONS.flatMap((section) =>
      Object.entries(target.manifest[section] ?? {}).map(([name, range]) => ({
        name,
        section,
        range,
      })),
    );
    const declared = allDeclared.filter((entry) => !unusedNames.has(entry.name));

    const requirement = readNodeRequirement(
      [
        { dir: target.dir, manifest: target.manifest },
        ...(workspaceRoot && workspaceManifest && target.dir !== workspaceRoot
          ? [{ dir: workspaceRoot, manifest: workspaceManifest }]
          : []),
      ],
      root,
    );
    const replaceable = findReplaceable(declared, requirement, (name) => {
      const reference = scan.usage.references.get(name);
      if (reference) return reference.symbols;
      return scan.usage.mentions.has(name) ? new Set(["*"]) : undefined;
    });

    const count = (classification: string) =>
      classified.unused.filter((entry) => entry.classification === classification).length;
    reports.push({
      name: target.name,
      dir: relative(root, target.dir) || ".",
      manifestPath: relative(root, join(target.dir, "package.json")) || "package.json",
      ...(requirement ? { node: requirement } : {}),
      counts: {
        declared: new Set(allDeclared.map((entry) => entry.name)).size,
        used: classified.used.length,
        certainlyUnused: count("certainly-unused"),
        probablyUnused: count("probably-unused"),
        usedIndirectly: count("used-indirectly"),
        replaceable: replaceable.filter((entry) => entry.status === "replaceable").length,
      },
      unused: classified.unused,
      replaceable,
      scan: {
        sourceFiles: scan.usage.sourceFiles,
        configFiles: scan.usage.configFiles,
        dynamicLoadFiles: scan.usage.dynamicLoadFiles,
        unparsedFiles: scan.usage.unparsedFiles,
        dependenciesInstalled: classified.dependenciesInstalled,
      },
    });
  }

  for (const report of reports) {
    if (!report.scan.dependenciesInstalled && report.counts.declared > 0) {
      notes.push(
        `${report.name}: dependencies are not installed, so commands and peer links could not be read and nothing is classified certainly-unused. Install, then run again.`,
      );
    }
  }

  // Lockfile: duplicates, depth, install scripts.
  const lock = readLockfile(root);
  let duplicates: DuplicatesReport;
  let installedPackages = 0;
  let maxDepth = 0;
  let directDependencies = reports.reduce((total, report) => total + report.counts.declared, 0);
  let installed = {
    installScriptPackages: [] as string[],
    deprecatedPackages: [] as string[],
    manifestsRead: 0,
  };
  if (lock.result.graph) {
    const graph = lock.result.graph;
    duplicates = analyzeDuplicates(graph);
    installedPackages = graph.nodes.size;
    const depths = dependencyDepths(graph);
    maxDepth = depths.maxDepth;
    directDependencies = depths.directDependencies || directDependencies;
    installed = inspectInstalled(graph);
  } else {
    duplicates = { supported: false, note: lock.result.unsupported, packages: [], extraCopies: 0 };
    notes.push(`Lockfile: ${lock.result.unsupported ?? "none"}.`);
  }

  const total = (pick: (report: DietPackageReport) => number) =>
    reports.reduce((sum, report) => sum + pick(report), 0);
  const certainlyUnused = total((report) => report.counts.certainlyUnused);
  const probablyUnused = total((report) => report.counts.probablyUnused);
  const replaceableCount = total((report) => report.counts.replaceable);

  const surface = attackSurface({
    installedPackages,
    directDependencies,
    maxDepth,
    installScriptPackages: installed.installScriptPackages,
    deprecatedPackages: installed.deprecatedPackages,
    manifestsRead: installed.manifestsRead,
    certainlyUnused,
    probablyUnused,
    replaceable: replaceableCount,
    extraCopies: duplicates.extraCopies,
    ...(lock.result.graph ? {} : { lockfileNote: lock.result.unsupported ?? "no lockfile" }),
    installedMissing:
      lock.result.graph !== undefined && installed.manifestsRead < installedPackages,
  });

  return {
    schemaVersion: "1",
    cwd,
    root,
    packageManager: detectPackageManager(root),
    ...(lock.file
      ? { lockfile: { path: lock.file, format: lock.result.graph?.format ?? "unsupported" } }
      : {}),
    generatedAt: new Date().toISOString(),
    packages: reports,
    duplicates,
    attackSurface: surface,
    summary: {
      packages: reports.length,
      certainlyUnused,
      probablyUnused,
      usedIndirectly: total((report) => report.counts.usedIndirectly),
      replaceable: replaceableCount,
      duplicatedPackages: duplicates.packages.length,
      score: surface.score,
    },
    notes,
  };
}
