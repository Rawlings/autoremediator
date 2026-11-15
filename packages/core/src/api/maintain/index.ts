import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { isValidPackageName, npmPurl } from "../../platform/maintainer-vex/index.js";
import type {
  CheckReachabilityOptions,
  ReachabilityAssessment,
  RemediateOptions,
  RemediationReport,
} from "../../platform/types.js";
import { parseScanInputFromAudit, uniqueCveIds } from "../../scanner/index.js";
import { PACKAGE_VERSION } from "../../version.js";
import { loadProjectLocks, occurrencesIn, type ProjectLocks } from "../incident/project.js";
import { renderDiff } from "../init/diff.js";
import type { FileChange } from "../init/types.js";
import { checkReachability } from "../reachability/index.js";
import { planRemediation } from "../remediate/index.js";
import { changesetName, editPackageJson, nextVersionOf, renderChangeset } from "./package-files.js";
import type {
  MaintainAdvisory,
  MaintainOptions,
  MaintainPackageFinding,
  MaintainPlanSummary,
  MaintainResult,
} from "./types.js";
import { mergeVexFile, type DraftStatement } from "./vex-file.js";

export type {
  MaintainAdvisory,
  MaintainDecision,
  MaintainOptions,
  MaintainPackageFinding,
  MaintainPlanSummary,
  MaintainResult,
} from "./types.js";
export { filesCover } from "./package-files.js";

/** The outside world `maintain` talks to, replaceable so tests need no network. */
export interface MaintainDeps {
  findAdvisories(cwd: string, options: MaintainOptions): Promise<string[]>;
  plan(id: string, options: RemediateOptions): Promise<RemediationReport>;
  reachability(options: CheckReachabilityOptions): Promise<ReachabilityAssessment>;
  now(): Date;
}

const ADVISORY_ID = /^(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/i;

const defaultDeps: MaintainDeps = {
  async findAdvisories(cwd, options) {
    if (options.offlineIntelligence) {
      throw new Error(
        "Audit needs the network. With offlineIntelligence, name the advisories to assess (advisories) and give an intelligenceSnapshotPath.",
      );
    }
    const findings = await parseScanInputFromAudit({
      cwd,
      packageManager: options.packageManager,
      format: "auto",
    });
    return uniqueCveIds(findings);
  },
  plan: planRemediation,
  reachability: checkReachability,
  now: () => new Date(),
};

interface Manifest {
  name: string;
  version: string;
  private: boolean;
  author: string;
}

function readManifest(cwd: string): Manifest {
  const path = join(cwd, "package.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `maintain needs the package's own package.json at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const { name, version } = raw;
  if (!isValidPackageName(name) || typeof version !== "string") {
    throw new Error(
      `${path} needs a valid "name" and a "version" for maintain to describe the package.`,
    );
  }
  let author: string = npmPurl(name);
  const declared = raw["author"];
  if (typeof declared === "string" && declared.trim() !== "") author = declared.trim();
  else if (typeof declared === "object" && declared !== null) {
    const { name: authorName, email } = declared as { name?: unknown; email?: unknown };
    if (typeof authorName === "string" && authorName.trim() !== "") {
      author =
        typeof email === "string" && email !== ""
          ? `${authorName.trim()} <${email}>`
          : authorName.trim();
    }
  }
  return { name, version, private: raw["private"] === true, author: author.slice(0, 512) };
}

function scopeOf(
  cwd: string,
  locks: ProjectLocks,
  name: string,
  version: string,
): MaintainPackageFinding["scope"] {
  if (locks.locks.length === 0) return "unknown";
  const found = occurrencesIn(cwd, locks.locks, (n, v) => n === name && v === version);
  if (found.length === 0) return "unknown";
  if (found.some((entry) => entry.scope === "production")) return "production";
  if (found.some((entry) => entry.scope === "development")) return "development";
  return "unreferenced";
}

function summarizePlan(report: RemediationReport): MaintainPlanSummary | undefined {
  const items = report.results
    .filter(
      (result) =>
        result.toVersion && (result.strategy === "version-bump" || result.strategy === "override"),
    )
    .map((result) => ({
      packageName: result.packageName,
      fromVersion: result.fromVersion,
      toVersion: result.toVersion!,
    }));
  if (items.length === 0 && !report.runId) return undefined;
  return {
    ...(report.runId ? { runId: report.runId } : {}),
    ...(report.planId ? { planId: report.planId } : {}),
    items,
    skipped: report.results.length - items.length,
  };
}

async function assess(
  id: string,
  options: MaintainOptions,
  cwd: string,
  locks: ProjectLocks,
  deps: MaintainDeps,
): Promise<MaintainAdvisory> {
  const report = await deps.plan(id, {
    cwd,
    source: options.source ?? "sdk",
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.packageManager ? { packageManager: options.packageManager } : {}),
    ...(options.offlineIntelligence ? { offlineIntelligence: true } : {}),
    ...(options.intelligenceSnapshotPath
      ? { intelligenceSnapshotPath: options.intelligenceSnapshotPath }
      : {}),
    // A recorded plan is a write under .autoremediator/, so only with approval.
    evidence: options.yes === true,
  });
  const severity = report.cveDetails?.severity;
  if (!report.cveDetails) {
    return { id, decision: "unknown", reason: report.summary, packages: [] };
  }

  const packages: MaintainPackageFinding[] = [];
  const seen = new Set<string>();
  for (const { installed } of report.vulnerablePackages) {
    const key = `${installed.name}@${installed.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scope = scopeOf(cwd, locks, installed.name, installed.version);
    const finding: MaintainPackageFinding = {
      name: installed.name,
      version: installed.version,
      scope,
    };
    if (scope === "production" || scope === "unknown") {
      const reach = await deps.reachability({
        cwd,
        packageName: installed.name,
        ...(options.traceFile ? { traceFile: options.traceFile } : {}),
      });
      finding.reachability = reach.status;
      finding.reason = reach.reason;
      if (reach.evidenceKind) finding.evidenceKind = reach.evidenceKind;
      if (reach.runtime) finding.runtimeVerdict = reach.runtime.verdict;
    }
    packages.push(finding);
  }

  const shipped = packages.filter(
    (entry) => entry.scope === "production" || entry.scope === "unknown",
  );
  const plan = summarizePlan(report);
  const base = { id, ...(severity ? { severity } : {}), packages, ...(plan ? { plan } : {}) };
  if (shipped.length === 0) {
    return {
      ...base,
      decision: "not-shipped",
      reason:
        packages.length === 0
          ? "No installed package matches the advisory."
          : "Only development or unreferenced dependencies match; consumers do not install them.",
    };
  }
  const reachable = shipped.filter((entry) => entry.reachability === "reachable");
  if (reachable.length > 0) {
    return {
      ...base,
      decision: "affected",
      reason: `This package reaches ${reachable.map((entry) => entry.name).join(", ")}: ${reachable[0]!.reason ?? "reachable"}`,
    };
  }
  const unknown = shipped.filter((entry) => entry.reachability !== "not-reachable");
  if (unknown.length > 0) {
    return {
      ...base,
      decision: "under_investigation",
      reason: `Reachability of ${unknown.map((entry) => entry.name).join(", ")} could not be decided.`,
    };
  }
  if (options.assertNotAffected) {
    return {
      ...base,
      decision: "not_affected",
      reason: `Asserted by the author: the static scan found no use of ${shipped.map((entry) => entry.name).join(", ")}.`,
    };
  }
  return {
    ...base,
    decision: "under_investigation",
    reason: `The static scan found no use of ${shipped.map((entry) => entry.name).join(", ")}, but not_affected is only written with assertNotAffected (--assert-not-affected) after you have reviewed it.`,
  };
}

function toDraft(advisory: MaintainAdvisory): DraftStatement | undefined {
  if (
    advisory.decision !== "not_affected" &&
    advisory.decision !== "affected" &&
    advisory.decision !== "under_investigation"
  ) {
    return undefined;
  }
  const shipped = advisory.packages.filter(
    (entry) => entry.scope === "production" || entry.scope === "unknown",
  );
  const evidence = shipped
    .map((entry) => {
      const basis = entry.evidenceKind === "both" ? "static scan and runtime trace" : "static scan";
      return `${entry.name}: ${entry.reachability ?? "unknown"} (${basis}${entry.runtimeVerdict ? `, trace: ${entry.runtimeVerdict}` : ""}) ${entry.reason ?? ""}`.trim();
    })
    .join("; ");
  const fixes = advisory.plan?.items.map((item) => `${item.packageName} ${item.toVersion}`) ?? [];
  const draft: DraftStatement = {
    advisory: advisory.id.toUpperCase(),
    status: advisory.decision,
    subcomponents: [...new Set(shipped.map((entry) => entry.name))],
    statusNotes:
      advisory.decision === "not_affected"
        ? `Assessed by the maintainer with autoremediator maintain and asserted with --assert-not-affected. ${evidence}`
        : `Assessed with autoremediator maintain. ${evidence}`,
  };
  if (advisory.decision === "affected") {
    draft.actionStatement =
      fixes.length > 0
        ? `Update to a release that depends on ${fixes.join(", ")} or later.`
        : "No fixed version of the dependency is known yet; follow the advisory.";
  }
  return draft;
}

function changesetLines(advisories: readonly MaintainAdvisory[]): string[] {
  const lines: string[] = [];
  for (const advisory of advisories) {
    const names = advisory.packages
      .filter((entry) => entry.scope === "production" || entry.scope === "unknown")
      .map((entry) => `\`${entry.name}\``)
      .join(", ");
    const fixes =
      advisory.plan?.items.map((item) => `\`${item.packageName}\` to ${item.toVersion}`) ?? [];
    switch (advisory.decision) {
      case "affected": {
        lines.push(
          fixes.length > 0
            ? `- Update ${fixes.join(", ")} to fix ${advisory.id}, which this package's code reaches.`
            : `- Track ${advisory.id} in ${names}: this package's code reaches it and no fixed version is known yet.`,
        );
        break;
      }
      case "not_affected": {
        lines.push(
          `- Declare in the shipped OpenVEX document that this package is not affected by ${advisory.id}: the vulnerable code in ${names} is not in its execute path.`,
        );
        break;
      }
      case "under_investigation": {
        lines.push(
          `- Record in the shipped OpenVEX document that ${advisory.id} in ${names} is under investigation.`,
        );
        break;
      }
      case "not-shipped":
      case "unknown": {
        break;
      }
    }
  }
  return lines;
}

function toChange(
  path: string,
  reason: string,
  before: string | undefined,
  merged: { content: string } | { conflict: string },
): FileChange {
  if ("conflict" in merged) {
    return {
      path,
      action: "conflict",
      reason: `${path} ${merged.conflict}`,
      ...(before === undefined ? {} : { before }),
      after: before ?? "",
    };
  }
  const action =
    before === undefined ? "create" : before === merged.content ? "unchanged" : "update";
  return {
    path,
    action,
    reason,
    ...(before === undefined ? {} : { before }),
    after: merged.content,
  };
}

const readIfExists = (cwd: string, path: string): string | undefined =>
  existsSync(join(cwd, path)) ? readFileSync(join(cwd, path), "utf8") : undefined;

/** The implementation with its outside world injectable. Use {@link maintain}. */
export async function maintainWith(
  deps: MaintainDeps,
  options: MaintainOptions = {},
): Promise<MaintainResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const manifest = readManifest(cwd);
  const notes: string[] = [];

  let ids: string[];
  if (options.advisories && options.advisories.length > 0) {
    const bad = options.advisories.filter((id) => !ADVISORY_ID.test(id));
    if (bad.length > 0) throw new Error(`Not a CVE or GHSA id: ${bad.join(", ")}`);
    ids = [...new Set(options.advisories.map((id) => id.toUpperCase()))];
  } else {
    ids = await deps.findAdvisories(cwd, options);
  }

  const locks = loadProjectLocks(cwd);
  notes.push(...locks.notes);

  const advisories: MaintainAdvisory[] = [];
  for (const id of ids.toSorted()) advisories.push(await assess(id, options, cwd, locks, deps));

  const usesChangesets = existsSync(join(cwd, ".changeset", "config.json"));
  const next = nextVersionOf(
    cwd,
    manifest.name,
    manifest.version,
    options.nextVersion,
    usesChangesets,
  );
  if (next.note) notes.push(next.note);

  const changes: FileChange[] = [];
  const drafts = advisories.flatMap((advisory) => {
    const draft = toDraft(advisory);
    return draft ? [draft] : [];
  });
  const written = advisories.filter((advisory) => toDraft(advisory) !== undefined);

  if (manifest.private) {
    notes.push(
      "This package is private, so it publishes nothing: no OpenVEX document or changeset was prepared.",
    );
  } else if (drafts.length > 0 && next.version) {
    const before = readIfExists(cwd, "package.json")!;
    const edit = editPackageJson(before);
    changes.push(
      toChange(
        "package.json",
        "declare the OpenVEX document (vex) and ship it (files)",
        before,
        edit,
      ),
    );
    if ("vexPath" in edit) {
      const existing = readIfExists(cwd, edit.vexPath);
      const merged = mergeVexFile({
        existing,
        packageName: manifest.name,
        version: next.version,
        author: manifest.author,
        tooling: `autoremediator ${PACKAGE_VERSION} maintain`,
        statements: drafts,
        now: deps.now(),
      });
      changes.push(
        toChange(
          edit.vexPath,
          `OpenVEX statements for ${manifest.name}@${next.version} (${written.map((entry) => `${entry.id}: ${entry.decision}`).join(", ")})`,
          existing,
          merged,
        ),
      );
      if (existsSync(join(cwd, ".npmignore"))) {
        notes.push(`.npmignore exists: check that it does not exclude ${edit.vexPath}.`);
      }
      if (!Array.isArray((JSON.parse(before) as { files?: unknown }).files)) {
        notes.push(
          `package.json has no "files" list, so ${edit.vexPath} ships unless .npmignore or .gitignore excludes it.`,
        );
      }
    }
    if (usesChangesets) {
      const lines = changesetLines(written);
      const path = `.changeset/${changesetName(written.map((entry) => entry.id))}.md`;
      const existing = readIfExists(cwd, path);
      changes.push(
        toChange(
          path,
          "release the dependency update and the VEX statements as a patch",
          existing,
          {
            content: renderChangeset(manifest.name, lines),
          },
        ),
      );
    } else {
      notes.push(
        "This repository does not use changesets (no .changeset/config.json), so no changeset was prepared: bump the version and write release notes yourself.",
      );
    }
  } else if (drafts.length > 0) {
    notes.push("No OpenVEX statements were prepared because the next version is not known.");
  }

  const pending = changes.filter(
    (change) => change.action === "create" || change.action === "update",
  );
  let applied = false;
  if (options.yes) {
    for (const change of pending) {
      const target = join(cwd, change.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, change.after, "utf8");
    }
    applied = pending.length > 0;
  }

  return {
    schemaVersion: "1.0",
    cwd,
    package: { name: manifest.name, version: manifest.version, private: manifest.private },
    ...(next.version ? { nextVersion: next.version } : {}),
    usesChangesets,
    advisories,
    changes: changes.map((change) => ({
      path: change.path,
      action: change.action,
      reason: change.reason,
      diff:
        change.action === "create" || change.action === "update"
          ? renderDiff(change.path, change.before, change.after)
          : "",
    })),
    drift: pending.length > 0,
    applied,
    conflicts: changes
      .filter((change) => change.action === "conflict")
      .map((change) => change.path),
    notes,
  };
}

/**
 * For package authors: when a dependency of the package you are developing gets an advisory, decide
 * whether your package is affected (reachability from your source, plus a runtime trace when given)
 * and prepare, never publish or push: a bump plan, a changeset when the repository uses them, and
 * an OpenVEX statement shipped in the package (`package.json#vex`). Nothing is written without `yes`.
 */
export function maintain(options: MaintainOptions = {}): Promise<MaintainResult> {
  return maintainWith(defaultDeps, options);
}
