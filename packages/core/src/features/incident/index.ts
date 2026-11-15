import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Packument } from "../guard/checks.js";
import { defaultGuardDeps } from "../guard/index.js";
import { checkInventoryTool } from "../remediate/tools/check-inventory.js";
import { persistPlan } from "../runs/index.js";
import { inRange } from "../scan/lock-graph/index.js";
import { scanSecrets } from "./ci-secrets.js";
import { scanHistory, type HistoryReport } from "./history.js";
import { renderIncidentMarkdown } from "./markdown.js";
import { declaredRange, loadProjectLocks, occurrencesIn } from "./project.js";
import { proposeRollbacks, rollbackReport } from "./rollback.js";
import { defaultTargetDeps, resolveTarget, type TargetDeps } from "./target.js";
import type {
  Exposure,
  IncidentOptions,
  IncidentReport,
  PackageExposure,
  Rollback,
} from "./types.js";

export { renderIncidentMarkdown } from "./markdown.js";
export { isAdvisoryId } from "./target.js";
export { scanSecrets } from "./ci-secrets.js";
export type {
  CiFile,
  ChecklistItem,
  ContainerFile,
  EnvTemplate,
  NpmrcFile,
  SecretsChecklist,
} from "./ci-secrets.js";
export type {
  CommitRef,
  HistoryReport,
  PackageHistory,
  VersionWindow,
  ManifestChange,
  RefSet,
} from "./history.js";
export type {
  AffectedRange,
  Exposure,
  IncidentOptions,
  IncidentReport,
  IncidentTarget,
  Occurrence,
  PackageExposure,
  Rollback,
  RollbackProposal,
} from "./types.js";

/** What an incident run reads from outside the project; replaceable so tests and embedders need no network. */
export interface IncidentDeps {
  target: TargetDeps;
  /** The registry document of a package, for the versions it has published. */
  fetchPackument(name: string, cwd: string): Promise<Packument | undefined>;
  /** Installed copies of a package, from the package manager's own inventory. */
  installed(
    cwd: string,
  ): Promise<Array<{ name: string; version: string; type: "direct" | "transitive" }>>;
  now(): number;
}

export const defaultIncidentDeps: IncidentDeps = {
  target: defaultTargetDeps,
  fetchPackument: (name, cwd) => defaultGuardDeps.fetchPackument(name, cwd),
  async installed(cwd) {
    const inventory = await checkInventoryTool.execute({ cwd });
    return inventory.error ? [] : inventory.packages;
  },
  now: () => Date.now(),
};

/**
 * Answer, locally and quickly, what a compromised package means for this project: is it here and
 * how did it get here, when did it come and go in git history, what would going back to the last
 * safe version look like, and which secrets were in reach of installs that ran while it was here.
 *
 * Reads the project, its lockfiles and git history; changes nothing. `plan: true` records the
 * rollback as a plan (never applied), `outputDir` writes the report as markdown and JSON. Needs no
 * network for `package@range`; an advisory id is looked up unless `offline` (with a snapshot).
 */
export async function incident(
  input: string,
  options: IncidentOptions = {},
  deps: IncidentDeps = defaultIncidentDeps,
): Promise<IncidentReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (!existsSync(join(cwd, "package.json"))) {
    throw new Error(`No package.json in ${cwd}: point --cwd at a Node.js project.`);
  }
  const target = await resolveTarget(input, options, deps.target);
  const notes: string[] = [];

  // 1. Exposure now, from the lockfiles.
  const { manifest, locks, notes: lockNotes } = loadProjectLocks(cwd);
  const packages: PackageExposure[] = target.affected.map((affected) => ({
    packageName: affected.name,
    range: affected.range,
    ...(declaredRange(manifest, affected.name)
      ? { declared: declaredRange(manifest, affected.name) }
      : {}),
    occurrences: occurrencesIn(cwd, locks, inRange(affected.name, affected.range)).map(
      ({ name: _name, ...rest }) => rest,
    ),
  }));

  if (existsSync(join(cwd, "node_modules"))) {
    try {
      const installed = await deps.installed(cwd);
      for (const entry of packages) {
        const range = inRange(entry.packageName, entry.range);
        const copies = installed.filter((copy) => range(copy.name, copy.version));
        if (copies.length > 0)
          entry.installed = copies.map((copy) => ({ version: copy.version, type: copy.type }));
      }
    } catch {
      notes.push(
        "The installed packages could not be listed, so only the lockfiles were checked for what is installed now.",
      );
    }
  }
  const exposure: Exposure = {
    exposed: packages.some(
      (entry) => entry.occurrences.length > 0 || (entry.installed?.length ?? 0) > 0,
    ),
    lockfiles: locks.map((lock) => lock.path),
    packages,
    notes: lockNotes,
  };

  // 2. History.
  let history: HistoryReport | undefined;
  if (options.history !== false) {
    history = await scanHistory({
      cwd,
      targets: target.affected.map((affected) => ({ name: affected.name, range: affected.range })),
      ...(options.maxCommits ? { maxCommits: options.maxCommits } : {}),
    });
  }

  // 3. Roll back to the last safe version.
  const published = new Map<string, string[] | undefined>();
  const rollbackNotes: string[] = [];
  if (exposure.exposed && !options.offline) {
    for (const entry of packages.filter((candidate) => candidate.occurrences.length > 0)) {
      try {
        const packument = await deps.fetchPackument(entry.packageName, cwd);
        published.set(
          entry.packageName,
          packument
            ? Object.entries(packument.versions ?? {})
                .filter(([, meta]) => !(meta as { deprecated?: unknown }).deprecated)
                .map(([version]) => version)
            : undefined,
        );
      } catch (error) {
        rollbackNotes.push(
          `The registry could not be read for ${entry.packageName} (${error instanceof Error ? error.message.slice(0, 100) : "error"}), so the rollback target comes from the project's own history.`,
        );
      }
    }
  }
  const proposals = proposeRollbacks({
    exposures: packages,
    histories: history?.packages ?? [],
    published,
  });
  const rollback: Rollback = { proposals, notes: rollbackNotes };
  if (exposure.exposed && proposals.length === 0) {
    rollback.notes.push(
      "An affected copy is in node_modules but not in any lockfile, so there is no locked version to pin back. Reinstall from the lockfile.",
    );
  }
  if (options.plan) {
    if (proposals.some((proposal) => proposal.toVersion)) {
      const report = rollbackReport({
        id:
          target.advisory?.id ??
          `incident:${target.affected.map((entry) => `${entry.name}@${entry.range}`).join(",")}`.slice(
            0,
            200,
          ),
        summary: `Incident rollback for ${target.input}: ${proposals.filter((proposal) => proposal.toVersion).length} of ${proposals.length} affected copies have a version to go back to.`,
        advisorySummary:
          target.advisory?.summary ??
          `Versions of ${target.affected.map((entry) => entry.name).join(", ")} reported compromised: ${input}`,
        affected: target.affected.map((entry) => ({
          name: entry.name,
          range: entry.range,
          source: target.advisory ? target.advisory.source : "user-supplied",
        })),
        proposals,
      });
      const recorded = await persistPlan(
        report,
        {
          cwd,
          ...(options.policy ? { policy: options.policy } : {}),
          source: options.source ?? "sdk",
        },
        cwd,
      );
      rollback.plan = recorded;
    } else {
      rollback.notes.push("No plan was recorded: there is no version to go back to.");
    }
  }

  // 4. What an install while it was here could have reached.
  const everPresent = history?.packages.some((entry) => entry.windows.length > 0) ?? false;
  const secrets = exposure.exposed || everPresent ? scanSecrets(cwd) : undefined;

  const report: IncidentReport = {
    schemaVersion: "1.0",
    generatedAt: new Date(deps.now()).toISOString(),
    cwd,
    target,
    exposure,
    ...(history ? { history } : {}),
    rollback,
    ...(secrets ? { secrets } : {}),
    notes,
  };

  if (options.outputDir) {
    const dir = resolve(options.outputDir);
    mkdirSync(dir, { recursive: true });
    const markdown = join(dir, "incident-report.md");
    const json = join(dir, "incident-report.json");
    // The report records where its own files are, so the JSON is written with that already set.
    report.files = { markdown, json };
    writeFileSync(markdown, renderIncidentMarkdown(report), "utf8");
    writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

/** Exit code for scripts: 0 clear, 3 not locked now but it was in history, 4 locked or installed now. */
export function incidentExitCode(report: IncidentReport): number {
  if (report.exposure.exposed) return 4;
  return report.history?.packages.some((entry) => entry.windows.length > 0) ? 3 : 0;
}
