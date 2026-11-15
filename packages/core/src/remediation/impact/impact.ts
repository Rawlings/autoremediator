/**
 * Upgrade impact: how likely moving a package from one version to another is to break THIS project.
 *
 * Two inputs are combined. The package's changes between the versions (public API from declaration
 * files, falling back to JavaScript exports; `engines`, module format, `exports` map, peers) and
 * the project's usage of the package (which exports and members its source touches, and where).
 * A change counts only through the project code it reaches, and every finding carries the file and
 * line of that code. The rating is a fixed table of points (see `IMPACT_POINTS`), not a model.
 */
import { compareSurfaces, type ApiChange, type ChangeSeverity } from "./api-diff.js";
import { extractDtsSurface, extractJsSurface, type ApiSurface } from "./dts-surface.js";
import { comparePackageManifests, isSubpathExported, type PackageLevelChange } from "./manifest-diff.js";
import { PackageIndex, specifierFor, type EntryPoint } from "./package-index.js";
import type { CallSite, PackageSource } from "./types.js";
import { sitesForExport, sitesForStaticMember, type UsageIndex } from "./usage-index.js";

export type Breakability = "High" | "Medium" | "Low";

export type FindingEvidence =
  /** The project's own call or reference sites reach the change. */
  | "project-usage"
  /** Only a member name matches (class instance members cannot be resolved without types). */
  | "name-match"
  /** The project's manifest proves it cannot meet the new requirement. */
  | "project-conflict"
  /** The project uses the package in ways that cannot be followed. */
  | "opaque-usage"
  /** A real package-level change whose effect depends on facts about the project we do not have. */
  | "unresolved";

/** Points per finding. The breakability rating is a function of these and nothing else. */
export const IMPACT_POINTS: Readonly<Record<FindingEvidence, Readonly<Record<ChangeSeverity, number>>>> = {
  "project-usage": { breaking: 50, "possibly-breaking": 20 },
  "name-match": { breaking: 20, "possibly-breaking": 8 },
  "project-conflict": { breaking: 50, "possibly-breaking": 50 },
  "opaque-usage": { breaking: 15, "possibly-breaking": 15 },
  unresolved: { breaking: 15, "possibly-breaking": 15 },
};

/** Score at which a rating with no hard finding becomes Medium. */
export const MEDIUM_THRESHOLD = 15;

/**
 * High needs a HARD finding: a breaking change reached by the project's own code, or a conflict
 * the project's manifest proves. Everything else tops out at Medium, however many findings.
 */
export function isHard(evidence: FindingEvidence, severity: ChangeSeverity): boolean {
  return severity === "breaking" && (evidence === "project-usage" || evidence === "project-conflict");
}

export interface ImpactFinding {
  scope: "api" | "package";
  category: string;
  severity: ChangeSeverity;
  evidence: FindingEvidence;
  points: number;
  specifier?: string;
  symbol?: string;
  member?: string;
  reason: string;
  before?: string;
  after?: string;
  /** Project code the change reaches (`file:line`), capped; see `totalCallSites`. */
  affectedCallSites: CallSite[];
  totalCallSites: number;
}

export interface Rating {
  score: number;
  breakability: Breakability;
}

/** The rating for a set of findings. Pure and deterministic. */
export function rate(findings: ReadonlyArray<Pick<ImpactFinding, "evidence" | "severity" | "points">>): Rating {
  const score = findings.reduce((total, finding) => total + finding.points, 0);
  if (findings.some((finding) => isHard(finding.evidence, finding.severity))) {
    return { score, breakability: "High" };
  }
  return { score, breakability: score >= MEDIUM_THRESHOLD ? "Medium" : "Low" };
}

export interface UpgradeImpact {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  breakability: Breakability;
  score: number;
  summary: string;
  findings: ImpactFinding[];
  /** Changes the project's code does not reach: not scored, but counted. */
  unreachedChanges: { breaking: number; possiblyBreaking: number };
  usage: {
    filesScanned: number;
    filesUsingPackage: number;
    specifiers: string[];
  };
  surface: {
    source: "types" | "js";
    entryPointsCompared: number;
    apiChanges: number;
  };
  limitations: string[];
  scoring: {
    points: typeof IMPACT_POINTS;
    mediumThreshold: number;
    rule: string;
  };
}

const MAX_SITES_PER_FINDING = 20;
const MAX_FINDINGS = 100;
const MAX_ENTRIES_COMPARED = 60;

const SCORING_RULE =
  "High if any finding is a breaking change reached by project code (project-usage) or a conflict with the project's own manifest (project-conflict); otherwise Medium if the points total is at least the Medium threshold; otherwise Low.";

function uniqueSites(sites: CallSite[]): CallSite[] {
  const seen = new Set<string>();
  const result: CallSite[] = [];
  for (const site of sites) {
    const key = `${site.file}:${site.line}:${site.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(site);
  }
  return result.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function pseudoEntry(index: PackageIndex, subpath: string): EntryPoint | undefined {
  const known = index.entries.find((entry) => entry.subpath === subpath);
  if (known) return known;
  if (index.source.manifest.exports !== undefined && index.source.manifest.exports !== null) return undefined;
  const relative = subpath.replace(/^\.\//, "");
  const file = index.resolveRelative("package.json", `./${relative}`);
  const base = relative.replace(/\.[cm]?js$/, "");
  const typesFile = [`${base}.d.ts`, `${base}/index.d.ts`].find((candidate) => index.hasFile(candidate));
  return file || typesFile ? { subpath, file, typesFile } : undefined;
}

function surfacesFor(
  before: PackageIndex,
  after: PackageIndex,
  oldEntry: EntryPoint,
  newEntry: EntryPoint,
): { before: ApiSurface; after: ApiSurface } | undefined {
  if (oldEntry.typesFile !== undefined && newEntry.typesFile !== undefined) {
    return {
      before: extractDtsSurface(before, oldEntry.typesFile),
      after: extractDtsSurface(after, newEntry.typesFile),
    };
  }
  if (oldEntry.file && newEntry.file) {
    return { before: extractJsSurface(before, oldEntry.file), after: extractJsSurface(after, newEntry.file) };
  }
  return undefined;
}

interface Intersection {
  sites: CallSite[];
  evidence: FindingEvidence;
  /** Every project call was compatible with the new signature. */
  compatible?: boolean;
}

function intersectApiChange(change: ApiChange, usage: UsageIndex): Intersection {
  const exportName = change.symbol === "module.exports" ? "default" : change.symbol;
  const exportSites = sitesForExport(usage, change.specifier, exportName);

  if (!change.member) {
    if (change.arity && change.category === "signature-changed") {
      const { min, max } = change.arity;
      const calls = exportSites.filter((site) => site.kind === "call" || site.kind === "new");
      const bad = calls.filter((site) => site.argCount !== undefined && (site.argCount < min || site.argCount > max));
      const unknown = exportSites.filter(
        (site) =>
          site.kind !== "import" &&
          (!(site.kind === "call" || site.kind === "new") || site.argCount === undefined),
      );
      if (bad.length > 0) return { sites: bad, evidence: "project-usage" };
      if (unknown.length > 0) return { sites: unknown, evidence: "project-usage" };
      return { sites: [], evidence: "project-usage", compatible: calls.length > 0 };
    }
    return { sites: exportSites, evidence: "project-usage" };
  }

  // Member of a class, interface, namespace, enum or object-valued export.
  const memberName = change.member.replace(/^(static|get|set) /, "");
  if (change.member === "[call]") {
    const calls = exportSites.filter((site) => site.kind === "call");
    if (change.arity) {
      const { min, max } = change.arity;
      const bad = calls.filter((site) => site.argCount !== undefined && (site.argCount < min || site.argCount > max));
      return { sites: bad, evidence: "project-usage", compatible: calls.length > 0 && bad.length === 0 };
    }
    return { sites: calls, evidence: "project-usage" };
  }
  const objectLike = change.memberOf === "enum" || change.memberOf === "namespace" || change.memberOf === "object" || change.member.startsWith("static ");
  if (objectLike) {
    // `pkg.member` where `pkg` is the module object (default export or `require()` result) is a
    // use of the export named `member`; for a named export it is a member access on that binding.
    const sites =
      exportName === "default"
        ? sitesForExport(usage, change.specifier, memberName)
        : sitesForStaticMember(usage, change.specifier, exportName, memberName);
    if (change.arity) {
      const { min, max } = change.arity;
      const bad = sites.filter((site) => site.kind === "call" && site.argCount !== undefined && (site.argCount < min || site.argCount > max));
      return { sites: bad, evidence: "project-usage", compatible: sites.length > 0 && bad.length === 0 };
    }
    return { sites, evidence: "project-usage" };
  }
  if (change.member === "[new]") {
    const constructed = exportSites.filter((site) => site.kind === "new");
    if (change.arity) {
      const { min, max } = change.arity;
      const bad = constructed.filter((site) => site.argCount !== undefined && (site.argCount < min || site.argCount > max));
      return { sites: bad, evidence: "project-usage", compatible: constructed.length > 0 && bad.length === 0 };
    }
    return { sites: constructed, evidence: "project-usage" };
  }
  // Instance member: the class has to be used at all, then match by member name.
  if (exportSites.length === 0) return { sites: [], evidence: "name-match" };
  const named = usage.memberNameUses.get(memberName) ?? [];
  return { sites: named, evidence: "name-match" };
}

function pointsFor(evidence: FindingEvidence, severity: ChangeSeverity): number {
  return IMPACT_POINTS[evidence][severity];
}

function toFinding(
  base: Omit<ImpactFinding, "points" | "affectedCallSites" | "totalCallSites">,
  sites: CallSite[],
): ImpactFinding {
  const unique = uniqueSites(sites);
  return {
    ...base,
    points: pointsFor(base.evidence, base.severity),
    affectedCallSites: unique.slice(0, MAX_SITES_PER_FINDING),
    totalCallSites: unique.length,
  };
}

export interface AnalyzeUpgradeInput {
  before: PackageSource;
  after: PackageSource;
  usage: UsageIndex;
  /** The project's own `package.json`, when there is one. */
  projectManifest?: Record<string, unknown>;
  runtimeNode?: string;
}

/** Pure analysis of an upgrade: no network, no file system. */
export function analyzeUpgrade(input: AnalyzeUpgradeInput): UpgradeImpact {
  const { before, after, usage, projectManifest } = input;
  const packageName = after.name;
  const oldIndex = new PackageIndex(before);
  const newIndex = new PackageIndex(after);
  const limitations: string[] = [];
  const findings: ImpactFinding[] = [];
  const unreached = { breaking: 0, possiblyBreaking: 0 };
  const countUnreached = (severity: ChangeSeverity): void => {
    if (severity === "breaking") unreached.breaking++;
    else unreached.possiblyBreaking++;
  };

  // Which subpaths to compare: the root, whatever the project imports, then the rest up to a cap.
  const usedSubpaths = [...usage.specifiers]
    .filter((specifier) => specifier.startsWith(`${packageName}/`))
    .map((specifier) => `./${specifier.slice(packageName.length + 1)}`);
  const subpaths = [
    ...new Set([
      ".",
      ...usedSubpaths,
      ...oldIndex.entries.map((entry) => entry.subpath),
      ...newIndex.entries.map((entry) => entry.subpath),
    ]),
  ].slice(0, MAX_ENTRIES_COMPARED + usedSubpaths.length);

  let sourceKind: "types" | "js" = "js";
  let compared = 0;
  const apiChanges: ApiChange[] = [];
  const notes = new Set<string>();

  for (const subpath of subpaths) {
    const specifier = specifierFor(packageName, subpath);
    const oldEntry = pseudoEntry(oldIndex, subpath);
    const newEntry = pseudoEntry(newIndex, subpath);
    const isUsed = usage.specifiers.has(specifier);
    if (oldEntry && !newEntry) {
      // The module was reachable before and is not now. With an `exports` map the package-level
      // comparison below reports it, so it is not reported twice.
      if (after.manifest.exports !== undefined && after.manifest.exports !== null) continue;
      if (isUsed) {
        findings.push(
          toFinding(
            {
              scope: "package",
              category: "removed-subpath",
              severity: "breaking",
              evidence: "project-usage",
              specifier,
              reason: `\`${specifier}\` can no longer be imported: ${subpath} is gone from the package${isSubpathExported(after.manifest, subpath) ? "" : " or no longer exported"}`,
            },
            usage.importSites.get(specifier) ?? [],
          ),
        );
      } else {
        countUnreached("breaking");
      }
      continue;
    }
    if (!oldEntry || !newEntry) continue;
    const surfaces = surfacesFor(oldIndex, newIndex, oldEntry, newEntry);
    if (!surfaces) continue;
    compared++;
    if (surfaces.before.source === "types") sourceKind = "types";
    for (const note of [...surfaces.before.notes, ...surfaces.after.notes]) notes.add(note);
    apiChanges.push(...compareSurfaces(specifier, surfaces.before, surfaces.after));
  }

  let opaqueBreaking = 0;
  for (const change of apiChanges) {
    const reach = intersectApiChange(change, usage);
    if (reach.sites.length === 0) {
      if (!reach.compatible && (usage.opaque.get(change.specifier)?.length ?? 0) > 0 && change.severity === "breaking") opaqueBreaking++;
      countUnreached(change.severity);
      continue;
    }
    findings.push(
      toFinding(
        {
          scope: "api",
          category: change.category,
          severity: change.severity,
          evidence: reach.evidence,
          specifier: change.specifier,
          symbol: change.symbol,
          member: change.member,
          reason: change.reason,
          before: change.before,
          after: change.after,
        },
        reach.sites,
      ),
    );
  }

  // The module object is used in ways we cannot follow, and the package has breaking changes.
  if (opaqueBreaking > 0) {
    const specifiersWithOpaque = [...usage.opaque.keys()].toSorted();
    const sites = specifiersWithOpaque.flatMap((specifier) => usage.opaque.get(specifier) ?? []);
    findings.push(
      toFinding(
        {
          scope: "api",
          category: "opaque-usage",
          severity: "possibly-breaking",
          evidence: "opaque-usage",
          reason: `the package object is used dynamically (passed along or accessed by computed name), so ${opaqueBreaking} breaking API change${opaqueBreaking === 1 ? "" : "s"} cannot be ruled out`,
        },
        sites,
      ),
    );
  }

  // Package-level changes.
  const projectUsesPackage = usage.specifiers.size > 0;
  const requireSites = [...usage.requireSites.values()].flat();
  const importSites = [...usage.importSites.values()].flat();
  const packageChanges = comparePackageManifests(before.manifest, after.manifest, projectManifest, input.runtimeNode);
  for (const change of packageChanges) {
    const finding = packageChangeFinding(change, { usage, packageName, requireSites, importSites, after });
    if (finding) findings.push(finding);
    else countUnreached(change.severity);
  }

  if (!projectUsesPackage) {
    limitations.push(
      `No source file in the project imports "${packageName}" directly. Usage through other packages that depend on it (transitive consumers) is not analysed, so only package-level findings can apply.`,
    );
  }
  if (usage.filesScanned === 0) limitations.push("No project source files were found to scan.");
  if (sourceKind === "js") {
    limitations.push(
      "No declaration files in both versions: the API was read from JavaScript exports, so parameter and return types are not compared. Types from @types packages are not consulted.",
    );
  }
  limitations.push(
    "Class and interface instance members are matched by member name only (no type information), so those findings are marked name-match and weigh less.",
    "Shadowed identifiers and aliasing through reassignment are not tracked.",
    ...notes,
  );
  if (!before.integrityVerified || !after.integrityVerified) {
    limitations.push("At least one tarball had no registry digest to verify against.");
  }

  const sorted = findings
    .toSorted(
      (a, b) =>
        b.points - a.points ||
        (a.specifier ?? "").localeCompare(b.specifier ?? "") ||
        (a.symbol ?? "").localeCompare(b.symbol ?? "") ||
        (a.member ?? "").localeCompare(b.member ?? ""),
    )
    .slice(0, MAX_FINDINGS);
  const { score, breakability } = rate(findings);

  return {
    packageName,
    fromVersion: before.version,
    toVersion: after.version,
    breakability,
    score,
    summary: summarize(breakability, findings, unreached, projectUsesPackage),
    findings: sorted,
    unreachedChanges: unreached,
    usage: {
      filesScanned: usage.filesScanned,
      filesUsingPackage: usage.filesUsingPackage,
      specifiers: [...usage.specifiers].toSorted(),
    },
    surface: { source: sourceKind, entryPointsCompared: compared, apiChanges: apiChanges.length },
    limitations: [...new Set(limitations)],
    scoring: { points: IMPACT_POINTS, mediumThreshold: MEDIUM_THRESHOLD, rule: SCORING_RULE },
  };
}

function usageSites(usage: UsageIndex, specifier: string): CallSite[] {
  const sites: CallSite[] = [];
  sites.push(...(usage.importSites.get(specifier) ?? []), ...(usage.requireSites.get(specifier) ?? []));
  return sites;
}

function packageChangeFinding(
  change: PackageLevelChange,
  context: {
    usage: UsageIndex;
    packageName: string;
    requireSites: CallSite[];
    importSites: CallSite[];
    after: PackageSource;
  },
): ImpactFinding | undefined {
  const base = {
    scope: "package" as const,
    category: change.category,
    reason: change.reason,
    before: change.before,
    after: change.after,
  };

  if (change.category === "exports-map") {
    const deepSpecifiers = [...context.usage.specifiers].filter((specifier) => specifier.startsWith(`${context.packageName}/`));
    const gone = deepSpecifiers.filter((specifier) => {
      const subpath = `./${specifier.slice(context.packageName.length + 1)}`;
      return change.restrictsDeepImports
        ? !isSubpathExported(context.after.manifest, subpath)
        : (change.removedSubpaths ?? []).includes(subpath) && !isSubpathExported(context.after.manifest, subpath);
    });
    if (gone.length === 0) return undefined;
    return toFinding(
      { ...base, severity: "breaking", evidence: "project-usage", specifier: gone[0], reason: `${change.reason}; the project imports ${gone.map((specifier) => `\`${specifier}\``).join(", ")}` },
      gone.flatMap((specifier) => usageSites(context.usage, specifier)),
    );
  }
  if (change.category === "module-format") {
    if (change.affectsRequire) {
      if (context.requireSites.length === 0) return undefined;
      return toFinding({ ...base, severity: change.severity, evidence: "project-usage" }, context.requireSites);
    }
    if (context.importSites.length === 0) return undefined;
    return toFinding({ ...base, severity: change.severity, evidence: "unresolved" }, context.importSites);
  }
  // engines and peer dependencies concern the project as a whole, not a call site.
  return toFinding(
    {
      ...base,
      severity: change.severity,
      evidence: change.evidence === "project-conflict" ? "project-conflict" : "unresolved",
    },
    [],
  );
}

function describeSite(site: CallSite): string {
  return `${site.file}:${site.line}`;
}

function summarize(
  breakability: Breakability,
  findings: ImpactFinding[],
  unreached: { breaking: number; possiblyBreaking: number },
  usesPackage: boolean,
): string {
  const hard = findings.filter((finding) => isHard(finding.evidence, finding.severity));
  const sites = uniqueSites(findings.flatMap((finding) => finding.affectedCallSites));
  const unreachedText =
    unreached.breaking + unreached.possiblyBreaking > 0
      ? ` ${unreached.breaking} breaking and ${unreached.possiblyBreaking} possibly-breaking change${unreached.breaking + unreached.possiblyBreaking === 1 ? "" : "s"} do not touch code in this project.`
      : "";
  if (breakability === "High") {
    return `High: ${hard.length} breaking change${hard.length === 1 ? "" : "s"} hit this project${sites.length > 0 ? `, e.g. ${sites.slice(0, 3).map((site) => describeSite(site)).join(", ")}` : ""}.${unreachedText}`;
  }
  if (breakability === "Medium") {
    return `Medium: ${findings.length} change${findings.length === 1 ? "" : "s"} may affect this project and could not be ruled out.${unreachedText}`;
  }
  if (!usesPackage) {
    return `Low: no source file imports the package directly; only package-level changes were checked.${unreachedText}`;
  }
  return `Low: no change reaches code in this project.${unreachedText}`;
}
