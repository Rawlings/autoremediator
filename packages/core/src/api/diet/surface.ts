import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { LockGraph } from "./lockfile.js";
import type { AttackSurface, SurfaceComponent } from "./types.js";
import { readManifest } from "./unused.js";

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"] as const;

/** Packages that run code when installed, and ones marked deprecated, read from what is installed. */
export function inspectInstalled(graph: LockGraph): {
  installScriptPackages: string[];
  deprecatedPackages: string[];
  manifestsRead: number;
} {
  const installScriptPackages: string[] = [];
  const deprecatedPackages: string[] = [];
  let manifestsRead = 0;

  for (const node of graph.nodes.values()) {
    let hasScript = node.hasInstallScript === true;
    let deprecated = node.deprecated;
    for (const file of node.manifestFiles) {
      const manifest = readManifest(file);
      if (!manifest) continue;
      manifestsRead += 1;
      const scripts = manifest.scripts ?? {};
      // npm also runs `node-gyp rebuild` for a package with a binding.gyp and no install script.
      hasScript =
        INSTALL_SCRIPTS.some((name) => typeof scripts[name] === "string") ||
        existsSync(join(dirname(file), "binding.gyp")) ||
        hasScript;
      if (typeof manifest.deprecated === "string") deprecated = manifest.deprecated;
      break;
    }
    if (hasScript) installScriptPackages.push(node.id);
    if (deprecated) deprecatedPackages.push(node.id);
  }
  return {
    installScriptPackages: installScriptPackages.toSorted(),
    deprecatedPackages: deprecatedPackages.toSorted(),
    manifestsRead,
  };
}

export interface SurfaceInputs {
  installedPackages: number;
  directDependencies: number;
  maxDepth: number;
  installScriptPackages: string[];
  deprecatedPackages: string[];
  manifestsRead: number;
  certainlyUnused: number;
  probablyUnused: number;
  replaceable: number;
  extraCopies: number;
  /** Why parts of the lockfile-derived numbers are missing. */
  lockfileNote?: string;
  /** The packages' installed manifests are missing, so install scripts could only come from the lockfile. */
  installedMissing: boolean;
}

const round = (value: number): number => Math.round(value * 10) / 10;

/**
 * The attack-surface score, written out. Each component is a count turned into points by a stated
 * rule, capped; the score is their sum, 0 to 100. Higher means more code you did not write runs in
 * your project. It ranks a project against its own past, not against a threshold: it is not a
 * probability of compromise.
 */
export function attackSurface(input: SurfaceInputs): AttackSurface {
  const size = round(30 * Math.min(1, Math.log(1 + input.installedPackages) / Math.log(1 + 2000)));
  const depth = round(10 * Math.min(1, Math.max(0, input.maxDepth - 1) / 9));
  const scripts = Math.min(20, 2 * input.installScriptPackages.length);
  const deprecated = Math.min(15, 2.5 * input.deprecatedPackages.length);
  const wasteValue = 1.5 * input.certainlyUnused + 0.5 * input.probablyUnused + input.replaceable;
  const waste = Math.min(15, wasteValue);
  const duplicates = Math.min(10, 0.5 * input.extraCopies);

  const components: SurfaceComponent[] = [
    {
      id: "size",
      label: "Installed packages",
      value: input.installedPackages,
      points: size,
      maxPoints: 30,
      formula: "30 * min(1, ln(1 + packages) / ln(2001)); reaches 30 at 2000 packages",
    },
    {
      id: "depth",
      label: "Dependency depth",
      value: input.maxDepth,
      points: depth,
      maxPoints: 10,
      formula:
        "10 * min(1, (depth - 1) / 9); depth is the longest shortest path from the project, in hops; reaches 10 at depth 10",
    },
    {
      id: "install-scripts",
      label: "Packages with install scripts",
      value: input.installScriptPackages.length,
      points: scripts,
      maxPoints: 20,
      formula: "2 per package that runs preinstall, install or postinstall code, up to 20",
    },
    {
      id: "deprecated",
      label: "Deprecated packages",
      value: input.deprecatedPackages.length,
      points: deprecated,
      maxPoints: 15,
      formula: "2.5 per package the lockfile marks deprecated, up to 15",
    },
    {
      id: "waste",
      label: "Unused and replaceable dependencies",
      value: round(wasteValue),
      points: round(waste),
      maxPoints: 15,
      formula:
        "1.5 per certainly-unused + 0.5 per probably-unused + 1 per replaceable dependency, up to 15",
    },
    {
      id: "duplicates",
      label: "Extra installed copies",
      value: input.extraCopies,
      points: duplicates,
      maxPoints: 10,
      formula: "0.5 per version beyond the first of a duplicated package, up to 10",
    },
  ];

  const limits: string[] = [];
  if (input.lockfileNote)
    limits.push(
      `${input.lockfileNote}; package count, depth, install scripts, deprecations and copies are not counted, so the score is a lower bound`,
    );
  else if (input.installedMissing) {
    limits.push(
      `only ${input.manifestsRead} of ${input.installedPackages} installed package.json files could be read (the rest are not installed here, such as optional packages for other platforms), so install scripts for those come only from lockfile flags and may be undercounted`,
    );
  }
  limits.push(
    "unmaintained packages are not detected: that needs registry data, and only the lockfile's deprecation flag is read",
  );

  return {
    score: Math.round(components.reduce((total, component) => total + component.points, 0)),
    formulaVersion: 1,
    components,
    facts: {
      installedPackages: input.installedPackages,
      directDependencies: input.directDependencies,
      maxDepth: input.maxDepth,
      installScriptPackages: input.installScriptPackages,
      deprecatedPackages: input.deprecatedPackages,
      certainlyUnused: input.certainlyUnused,
      probablyUnused: input.probablyUnused,
      replaceable: input.replaceable,
      extraCopies: input.extraCopies,
      manifestsRead: input.manifestsRead,
    },
    limits,
  };
}
