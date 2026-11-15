import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadPolicy } from "../../infra/policy/policy.js";
import type { AutoremediatorPolicy } from "../../infra/policy/policy.js";
import { LEVEL_NAMES } from "../autonomy/types.js";
import { computeEscalationAction } from "../remediate/escalation.js";
import { sanitizeNote } from "./sanitize.js";

/** One sentence about one part of the policy, with the key it comes from. */
export interface PolicyRule {
  /** Dotted policy key, e.g. `denyPackages`. */
  key: string;
  sentence: string;
}

export interface ExplainPolicyOptions {
  /** Project directory (default: process.cwd()). */
  cwd?: string;
  /** Policy file path or inline YAML (default: `.github/autoremediator.yml`). */
  policy?: string;
}

export interface ExplainPolicyResult {
  /** Where the policy was read from, relative to `cwd` when inside it; `(inline policy)` for inline text. */
  source: string;
  /** False when no policy file exists and the built-in defaults are described. */
  exists: boolean;
  rules: PolicyRule[];
  /** The rules as plain sentences, in order. */
  sentences: string[];
}

const list = (values: readonly string[]): string => values.join(", ");
const hours = (value: number): string =>
  value % 24 === 0 && value >= 48 ? `${value / 24} days` : `${value} hours`;

/**
 * Describe a loaded policy in plain sentences. Pure and deterministic: no model, the same policy
 * always gives the same text. It is the reading of a policy that `compilePolicy` is tested against.
 */
export function describePolicy(policy: AutoremediatorPolicy): PolicyRule[] {
  const rules: PolicyRule[] = [];
  const add = (key: string, sentence: string): void => {
    rules.push({ key, sentence });
  };

  add(
    "allowMajorBumps",
    policy.allowMajorBumps
      ? "Major version upgrades are allowed."
      : "Major version upgrades are never made.",
  );
  if (policy.denyPackages.length > 0) {
    add("denyPackages", `Never touch these packages: ${list(policy.denyPackages)}.`);
  }
  if (policy.allowPackages.length > 0) {
    add("allowPackages", `Only these packages may be changed: ${list(policy.allowPackages)}.`);
  }

  const constraints = policy.constraints ?? {};
  if (constraints.directDependenciesOnly) {
    add(
      "constraints.directDependenciesOnly",
      "Only direct dependencies are changed; transitive ones are left alone.",
    );
  }
  if (constraints.preferVersionBump) {
    add(
      "constraints.preferVersionBump",
      "Only version bumps are used: no overrides and no patches.",
    );
  }
  if (constraints.typecheck) {
    add("constraints.typecheck", "The type check must pass after each change.");
  }
  if (constraints.requireProofOfFix) {
    add("constraints.requireProofOfFix", "A change is rolled back unless its proof of fix passes.");
  }
  if (constraints.enableBreakingChangeRefactor) {
    add(
      "constraints.enableBreakingChangeRefactor",
      "Experimental codemods may repair breaking API changes.",
    );
  }
  if (constraints.enforceFrozenLockfile) {
    add("constraints.enforceFrozenLockfile", "Installs must use the frozen lockfile.");
  }
  if (constraints.workspace) {
    add(
      "constraints.workspace",
      `Work is scoped to the workspace package ${constraints.workspace}.`,
    );
  }
  const supply = constraints.supplyChainPolicy;
  if (supply?.minPublishAgeHours !== undefined && supply.minPublishAgeHours > 0) {
    add(
      "constraints.supplyChainPolicy.minPublishAgeHours",
      `Versions published less than ${hours(supply.minPublishAgeHours)} ago are skipped.`,
    );
  }
  if (supply?.blockInstallScripts) {
    add(
      "constraints.supplyChainPolicy.blockInstallScripts",
      "Versions with install scripts are skipped.",
    );
  }
  if (supply?.requireProvenance) {
    add(
      "constraints.supplyChainPolicy.requireProvenance",
      "A version must carry a provenance attestation.",
    );
  }

  const exploit = policy.exploitSignalOverride;
  if (exploit?.kev?.mandatory) {
    add(
      "exploitSignalOverride.kev",
      "Vulnerabilities on the CISA KEV list are always remediated, whatever their severity.",
    );
  }
  if (exploit?.epss?.mandatory) {
    add(
      "exploitSignalOverride.epss",
      `Vulnerabilities with an EPSS score above ${exploit.epss.threshold} are always remediated, whatever their severity.`,
    );
  }

  for (const entry of policy.suppressions ?? []) {
    const note = entry.notes ? ` (${sanitizeNote(entry.notes)})` : "";
    const until = entry.expiresAt ? ` until ${entry.expiresAt.slice(0, 10)}` : " with no expiry";
    add("suppressions", `${entry.cveId} is suppressed as ${entry.justification}${until}${note}.`);
  }

  const sla = policy.sla;
  if (sla) {
    for (const severity of ["critical", "high", "medium", "low"] as const) {
      const limit = sla[severity];
      if (limit !== undefined) {
        add(
          `sla.${severity}`,
          `${severity[0]!.toUpperCase()}${severity.slice(1)} vulnerabilities must be fixed within ${hours(limit)} of publication.`,
        );
      }
    }
  }

  if (policy.skipUnreachable) {
    add("skipUnreachable", "Vulnerabilities in code the project never reaches are skipped.");
  }

  const disposition = policy.dispositionPolicy;
  if (disposition?.minConfidenceForAutoApply !== undefined) {
    add(
      "dispositionPolicy.minConfidenceForAutoApply",
      `A change is applied automatically only at confidence ${disposition.minConfidenceForAutoApply} or higher; below that it is held for approval.`,
    );
  }
  if (disposition?.holdForTransitive) {
    add(
      "dispositionPolicy.holdForTransitive",
      "Changes to transitive dependencies are held for approval.",
    );
  }
  if (disposition?.escalateOnKev === false) {
    add("dispositionPolicy.escalateOnKev", "Known-exploited vulnerabilities are not escalated.");
  }
  if (disposition?.escalateOnSlaBreachSeverities) {
    add(
      "dispositionPolicy.escalateOnSlaBreachSeverities",
      disposition.escalateOnSlaBreachSeverities.length === 0
        ? "SLA breaches are not escalated at any severity."
        : `SLA breaches are escalated at ${list(disposition.escalateOnSlaBreachSeverities)}.`,
    );
  }
  if (policy.containmentMode) {
    add(
      "containmentMode",
      "A change that ends up held for approval is rolled back until someone approves it.",
    );
  }
  for (const reason of Object.keys(policy.escalationGraph ?? {}).toSorted()) {
    const action = computeEscalationAction(reason as never, policy.escalationGraph);
    add(
      `escalationGraph.${reason}`,
      action === "none"
        ? `Nothing is escalated when a result is unresolved as ${reason}.`
        : `When a result is unresolved as ${reason}, the follow-up is ${action}.`,
    );
  }

  if (policy.autonomy) {
    add(
      "autonomy.ceiling",
      `The autonomy ceiling is ${policy.autonomy.ceiling} (${LEVEL_NAMES[policy.autonomy.ceiling]}); Autoremediator never merges anything itself.`,
    );
  } else {
    add("autonomy", "No autonomy ceiling is set, so earned autonomy is off.");
  }
  if (policy.recipes?.packages.length) {
    add("recipes.packages", `Recipes are trusted from: ${list(policy.recipes.packages)}.`);
  }
  return rules;
}

/**
 * Read the project's policy and describe it in plain sentences, with no model. A missing default
 * file is described as the built-in defaults; a broken policy is an error, as everywhere else.
 */
export function explainPolicy(options: ExplainPolicyOptions = {}): ExplainPolicyResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const explicit = options.policy?.trim() ? options.policy : undefined;
  const inline = explicit !== undefined && /^(?:\{|---)/.test(explicit.trim());
  const path = inline ? undefined : resolve(cwd, explicit ?? join(".github", "autoremediator.yml"));
  const exists = inline || (path !== undefined && existsSync(path));
  const policy = loadPolicy(cwd, inline ? explicit : explicit === undefined ? undefined : path);
  const rules = describePolicy(policy);
  return {
    source: inline ? "(inline policy)" : (explicit ?? join(".github", "autoremediator.yml")),
    exists,
    rules,
    sentences: rules.map((rule) => rule.sentence),
  };
}
