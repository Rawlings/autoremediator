import { isActiveSuppression } from "../../platform/policy.js";
import type { CveDetails, VexSuppression } from "../../platform/types.js";
import type { RunRecord, RunStore } from "../../runs/run-store.js";
import { factKey } from "./components.js";

export type VexStatus = "fixed" | "affected" | "not_affected" | "under_investigation";

export type OpenVexJustification =
  | "component_not_present"
  | "vulnerable_code_not_present"
  | "vulnerable_code_not_in_execute_path"
  | "vulnerable_code_cannot_be_controlled_by_adversary"
  | "inline_mitigations_already_exist";

export type CycloneDxJustification = "code_not_present" | "protected_by_mitigating_control";

export interface FindingComponent {
  name: string;
  version: string;
}

/** One assertion the evidence pack makes about one advisory and, where known, one component. */
export interface VexFinding {
  cveId: string;
  status: VexStatus;
  /**
   * What the statement is about: the locked package. For `fixed`, the version that now carries the
   * fix; otherwise the version the advisory matched. Absent for a policy suppression that matched
   * no recorded run.
   */
  component?: FindingComponent;
  /** Where the claim comes from: a recorded run and the lockfile, or the project's policy file. */
  basis: "run" | "policy";
  runIds: string[];
  /** One sentence for a human reader. */
  detail: string;
  openVexJustification?: OpenVexJustification;
  cycloneDxJustification?: CycloneDxJustification;
  /** Required by OpenVEX when the status is `affected`. */
  actionStatement?: string;
  /** Free-text reason for a `not_affected` or suppressed statement when no machine-readable justification applies. */
  impactStatement?: string;
  /** The version the plan or run moves the component to. */
  targetVersion?: string;
  /** Planned or applied fix exists, so CycloneDX `response: update`. */
  updateAvailable: boolean;
}

export interface FindingsResult {
  findings: VexFinding[];
  /** Advisory details from the newest recorded report that has them. */
  cves: Map<string, CveDetails | null>;
  /** Runs whose report was used, newest first. */
  usedRuns: string[];
  notes: string[];
}

interface Observation {
  cveId: string;
  name: string;
  fromVersion: string;
  toVersion?: string;
  runId: string;
  planned: boolean;
  applied: boolean;
  verified: boolean;
  strategy: string;
  unresolvedReason?: string;
  message: string;
}

function observeRun(
  store: RunStore,
  run: RunRecord,
  notes: string[],
): {
  observations: Observation[];
  details?: { cveId: string; details: CveDetails | null };
} {
  const report = store.readReport(run.runId);
  if (!report) {
    notes.push(
      `Run ${run.runId} has no stored report, so it contributes no vulnerability statements.`,
    );
    return { observations: [] };
  }
  const plan = store.readPlan(run.runId);
  const ledger = store.ledger(run.runId);
  const check = ledger.verify();
  if (!check.ok) {
    notes.push(
      `Run ${run.runId}: its ledger failed verification (${check.reason}), so its apply results are not trusted; its findings are listed as not applied.`,
    );
  }
  const done = new Map<string, { applied: boolean; verified: boolean }>();
  if (check.ok) {
    for (const event of ledger.read()) {
      if (event.type !== "item.done") continue;
      done.set(String(event.data["itemId"]), {
        applied: event.data["status"] === "applied",
        verified: event.data["verified"] === true,
      });
    }
  }

  const observations = report.results.map((result): Observation => {
    const item = plan?.items.find(
      (candidate) =>
        candidate.packageName === result.packageName &&
        candidate.fromVersion === result.fromVersion,
    );
    const outcome = item ? done.get(item.itemId) : undefined;
    return {
      cveId: report.cveId,
      name: result.packageName,
      fromVersion: result.fromVersion,
      ...(item?.toVersion
        ? { toVersion: item.toVersion }
        : result.toVersion
          ? { toVersion: result.toVersion }
          : {}),
      runId: run.runId,
      planned: item !== undefined,
      applied: Boolean(outcome?.applied) && run.status !== "rolled-back",
      verified: Boolean(outcome?.verified),
      strategy: item?.strategy ?? result.strategy,
      ...(result.unresolvedReason ? { unresolvedReason: result.unresolvedReason } : {}),
      message: result.message,
    };
  });
  return { observations, details: { cveId: report.cveId, details: report.cveDetails } };
}

function statusOfObservations(
  observations: Observation[],
  locked: Set<string> | undefined,
): Omit<VexFinding, "cveId" | "basis" | "runIds"> {
  const first = observations[0]!;
  const component = { name: first.name, version: first.fromVersion };
  const stillLocked = locked?.has(factKey(first.name, first.fromVersion));
  const applied = observations.find((observation) => observation.applied && observation.toVersion);

  if (applied && stillLocked !== true) {
    return {
      status: "fixed",
      component: { name: applied.name, version: applied.toVersion! },
      detail: `${applied.name} was changed from ${applied.fromVersion} to ${applied.toVersion} by run ${applied.runId} (${applied.strategy})${applied.verified ? " and the change passed the verifier" : ""}.`,
      targetVersion: applied.toVersion!,
      updateAvailable: true,
    };
  }
  if (applied) {
    return {
      status: "affected",
      component,
      detail: `Run ${applied.runId} changed ${applied.name} to ${applied.toVersion}, but ${applied.name}@${applied.fromVersion} is locked again.`,
      actionStatement: `Upgrade ${applied.name} to ${applied.toVersion} again; the earlier change is no longer in the lockfile.`,
      targetVersion: applied.toVersion!,
      updateAvailable: true,
    };
  }
  if (locked !== undefined && stillLocked === false) {
    return {
      status: "not_affected",
      component,
      detail: `${first.name}@${first.fromVersion} matched the advisory in run ${first.runId} but is not in the current lockfile, and no recorded run applied a fix.`,
      openVexJustification: "component_not_present",
      cycloneDxJustification: "code_not_present",
      updateAvailable: false,
    };
  }

  const planned = observations.find((observation) => observation.planned && observation.toVersion);
  if (planned) {
    return {
      status: "affected",
      component,
      detail: `${planned.name}@${planned.fromVersion} matches the advisory; run ${planned.runId} planned an upgrade to ${planned.toVersion} that has not been applied.`,
      actionStatement: `Upgrade ${planned.name} to ${planned.toVersion} (planned in run ${planned.runId}; review and apply it).`,
      targetVersion: planned.toVersion!,
      updateAvailable: true,
    };
  }
  const reason = first.unresolvedReason ?? first.message;
  return {
    status: "affected",
    component,
    detail: `${first.name}@${first.fromVersion} matches the advisory and no fix was applied (${reason}).`,
    actionStatement: `No automatic fix was found (${reason}). Upgrade or replace ${first.name}, or add a reviewed patch.`,
    updateAvailable: false,
  };
}

type SuppressionStatement = Pick<
  VexFinding,
  "status" | "openVexJustification" | "cycloneDxJustification"
> & { phrase: string; impact: string };

const SUPPRESSION_STATEMENTS: Record<VexSuppression["justification"], SuppressionStatement> = {
  not_affected: {
    status: "not_affected",
    phrase: "as not affected",
    impact: "not affecting the product",
  },
  mitigated: {
    status: "not_affected",
    openVexJustification: "inline_mitigations_already_exist",
    cycloneDxJustification: "protected_by_mitigating_control",
    phrase: "as mitigated",
    impact: "mitigated",
  },
  fixed: { status: "fixed", phrase: "as fixed", impact: "fixed" },
  under_investigation: {
    status: "under_investigation",
    phrase: "while under investigation",
    impact: "under investigation",
  },
};

function suppressionStatement(suppression: VexSuppression): Pick<
  VexFinding,
  "status" | "detail" | "openVexJustification" | "cycloneDxJustification"
> & {
  impactStatement: string;
} {
  const entry = SUPPRESSION_STATEMENTS[suppression.justification];
  const note = suppression.notes ? `: ${suppression.notes}` : "";
  const asserted = "asserted in the project's policy file, not verified by autoremediator";
  return {
    status: entry.status,
    detail: `Suppressed ${entry.phrase}${note} (${asserted}).`,
    ...(entry.openVexJustification ? { openVexJustification: entry.openVexJustification } : {}),
    ...(entry.cycloneDxJustification
      ? { cycloneDxJustification: entry.cycloneDxJustification }
      : {}),
    impactStatement: `The project's policy marks this advisory as ${entry.impact}${note}.`,
  };
}

/**
 * What the pack asserts, from two sources only: the project's policy suppressions, and the runs
 * recorded under `.autoremediator/runs/`, read against what the lockfile locks now. Nothing is
 * looked up and nothing is inferred beyond that; an advisory with no recorded run and no
 * suppression does not appear.
 */
export function collectFindings(input: {
  store: RunStore;
  runs: RunRecord[];
  suppressions: VexSuppression[];
  /** `name@version` the lockfile locks now, or undefined when no lockfile could be read. */
  locked: Set<string> | undefined;
}): FindingsResult {
  const notes: string[] = [];
  const cves = new Map<string, CveDetails | null>();
  const byComponent = new Map<string, Observation[]>();
  const usedRuns: string[] = [];

  // Newest first, so the first details seen for an advisory are the freshest.
  for (const run of input.runs.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const { observations, details } = observeRun(input.store, run, notes);
    if (observations.length === 0 && !details) continue;
    usedRuns.push(run.runId);
    if (details && !cves.get(details.cveId)) cves.set(details.cveId, details.details);
    for (const observation of observations) {
      const key = `${observation.cveId}|${factKey(observation.name, observation.fromVersion)}`;
      byComponent.set(key, [...(byComponent.get(key) ?? []), observation]);
    }
  }

  const active = input.suppressions.filter((suppression) => isActiveSuppression(suppression));
  const expired = input.suppressions.length - active.length;
  if (expired > 0) {
    notes.push(`${expired} expired suppression${expired === 1 ? " was" : "s were"} left out.`);
  }
  const suppressedCves = new Map(
    active.map((suppression) => [suppression.cveId.toUpperCase(), suppression]),
  );

  const findings: VexFinding[] = [];
  for (const observations of byComponent.values()) {
    const cveId = observations[0]!.cveId;
    const suppression = suppressedCves.get(cveId.toUpperCase());
    const runIds = [...new Set(observations.map((observation) => observation.runId))];
    if (suppression) {
      const statement = suppressionStatement(suppression);
      const finding: VexFinding = {
        cveId,
        status: statement.status,
        component: { name: observations[0]!.name, version: observations[0]!.fromVersion },
        basis: "policy",
        runIds,
        detail: statement.detail,
        impactStatement: statement.impactStatement,
        ...(statement.openVexJustification
          ? { openVexJustification: statement.openVexJustification }
          : {}),
        ...(statement.cycloneDxJustification
          ? { cycloneDxJustification: statement.cycloneDxJustification }
          : {}),
        updateAvailable: false,
      };
      findings.push(finding);
      continue;
    }
    findings.push({
      cveId,
      basis: "run",
      runIds,
      ...statusOfObservations(observations, input.locked),
    });
  }

  // A suppression for an advisory no recorded run saw is still a statement the project made.
  const seen = new Set(findings.map((finding) => finding.cveId.toUpperCase()));
  for (const [cveId, suppression] of suppressedCves) {
    if (seen.has(cveId)) continue;
    const statement = suppressionStatement(suppression);
    const finding: VexFinding = {
      cveId: suppression.cveId,
      status: statement.status,
      basis: "policy",
      runIds: [],
      detail: statement.detail,
      impactStatement: statement.impactStatement,
      ...(statement.openVexJustification
        ? { openVexJustification: statement.openVexJustification }
        : {}),
      ...(statement.cycloneDxJustification
        ? { cycloneDxJustification: statement.cycloneDxJustification }
        : {}),
      updateAvailable: false,
    };
    findings.push(finding);
  }

  return {
    findings: findings.toSorted(
      (a, b) =>
        a.cveId.localeCompare(b.cveId) ||
        `${a.component?.name}@${a.component?.version}`.localeCompare(
          `${b.component?.name}@${b.component?.version}`,
        ),
    ),
    cves,
    usedRuns,
    notes,
  };
}
