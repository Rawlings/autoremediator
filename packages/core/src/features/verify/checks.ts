import semver from "semver";

import { loadRegistryConfig } from "../../infra/http/registry-config.js";
import { readCooldown, withCooldown } from "../../infra/package-manager/cooldown.js";
import {
  detectPackageManager,
  getYarnMajorVersion,
  resolveInstallCommand,
  resolveTypecheckCommand,
} from "../../infra/package-manager/index.js";
import { DEFAULT_POLICY, isPackageAllowed, loadPolicy } from "../../infra/policy/policy.js";
import type { AutoremediatorPolicy } from "../../infra/policy/policy.js";
import { errorMessage } from "../../shared/errors.js";
import { MEMORY_PATH, TRACK_RECORD_PATH } from "../../shared/state-paths.js";
import type { PackageManager } from "../../shared/types.js";
import { verifyPackageTrust } from "../guard/supply-chain.js";
import type { InventoryPackage } from "../intelligence/types.js";
import { resolveProjectTestCommand } from "../memory/test-command.js";
import { findVulnerablePackages } from "../remediate/local/vulnerability-match.js";
import { checkInventoryTool } from "../remediate/tools/check-inventory.js";
import {
  changedFilesSince,
  classifyPath,
  type DeclarationChange,
  manifestChanges,
} from "./changes.js";
import { runCommandCheck, tail } from "./command-check.js";
import { prepareReproductionTestFile, runProofOfFixPhase } from "./proof-of-fix/runner.js";
import type { CheckName, CheckStatus, VerifyOptions, VerifyRequest } from "./types.js";

export interface CheckOutcome {
  status: CheckStatus;
  message: string;
  details?: string[];
  command?: string[];
}

/** Shared, lazily computed facts about the change, so checks do not repeat the work. */
export interface CheckContext {
  request: VerifyRequest;
  options: VerifyOptions;
  packageManager: PackageManager;
  policy: AutoremediatorPolicy;
  /** Set when the policy file exists but could not be read; the `policy` check fails on it. */
  policyError?: string;
  changedFiles: () => Promise<string[] | undefined>;
  changes: () => DeclarationChange[];
  inventory: () => Promise<{ packages: InventoryPackage[] } | { error: string }>;
}

export type CheckFn = (context: CheckContext) => Promise<CheckOutcome>;

const pass = (message: string, details?: string[]): CheckOutcome => ({
  status: "passed",
  message,
  ...(details ? { details } : {}),
});
const fail = (message: string, details?: string[]): CheckOutcome => ({
  status: "failed",
  message,
  ...(details ? { details } : {}),
});
const skip = (message: string): CheckOutcome => ({ status: "skipped", message });

export function createCheckContext(request: VerifyRequest): CheckContext {
  const options = request.options ?? {};
  const packageManager = request.packageManager ?? detectPackageManager(request.cwd);

  let policy: AutoremediatorPolicy = DEFAULT_POLICY;
  let policyError: string | undefined;
  try {
    policy = loadPolicy(request.cwd, request.policy);
  } catch (error) {
    policyError = errorMessage(error);
  }

  let files: Promise<string[] | undefined> | undefined;
  let changes: DeclarationChange[] | undefined;
  let inventory: Promise<{ packages: InventoryPackage[] } | { error: string }> | undefined;

  return {
    request,
    options,
    packageManager,
    policy,
    ...(policyError ? { policyError } : {}),
    changedFiles: () =>
      (files ??= changedFilesSince(
        request.cwd,
        request.statusBefore,
        options.ignoreTrackRecord ? [TRACK_RECORD_PATH, MEMORY_PATH] : [],
      )),
    changes: () => (changes ??= manifestChanges(request.cwd, request.baseFiles)),
    inventory: () =>
      (inventory ??= checkInventoryTool
        .execute({
          cwd: request.cwd,
          packageManager,
          policy: request.policy,
          workspace: options.constraints?.workspace ?? policy.constraints?.workspace,
        })
        .then((result) => (result.error ? { error: result.error } : { packages: result.packages }))
        .catch((error: unknown) => ({
          error: errorMessage(error),
        }))),
  };
}

/** Merge the run's constraints over the policy's. */
const constraintsOf = (context: CheckContext) => ({
  ...context.policy.constraints,
  ...context.options.constraints,
});

/** Only the files a dependency change may touch (plus the project's source, if allowed) changed. */
const scope: CheckFn = async (context) => {
  const files = await context.changedFiles();
  if (files === undefined)
    return skip("not a git repository, so the changed files cannot be listed");

  const violations: string[] = [];
  for (const file of files) {
    const kind = classifyPath(file);
    if (kind === "forbidden") violations.push(`${file}: never changed by remediation`);
    else if (kind === "source" && !context.options.allowSourceEdits) {
      violations.push(`${file}: project source, but this change may only touch dependency files`);
    } else if (kind === "tooling") {
      violations.push(`${file}: build or test configuration, which runs code`);
    } else if (kind === "other") violations.push(`${file}: not a dependency file`);
  }
  return violations.length > 0
    ? fail(`${violations.length} change(s) outside the allowed scope`, violations)
    : pass(`${files.length} changed file(s), all within scope`);
};

const versionOf = (spec: string): string | undefined => {
  try {
    return semver.minVersion(spec)?.version;
  } catch {
    return undefined;
  }
};

/** The change respects the policy: allow/deny lists, major bumps and the strategy constraints. */
const policyCheck: CheckFn = async (context) => {
  if (context.policyError) return fail("the policy could not be loaded", [context.policyError]);

  const constraints = constraintsOf(context);
  const violations: string[] = [];
  for (const change of context.changes()) {
    if (change.to === undefined) continue;
    const label = `${change.name} ${change.from ?? "(new)"} -> ${change.to}`;

    if (!isPackageAllowed(context.policy, change.name)) {
      violations.push(`${label}: blocked by allowPackages/denyPackages`);
    }
    if (change.kind === "override" && constraints.directDependenciesOnly) {
      violations.push(
        `${label}: an override changes a transitive dependency, but directDependenciesOnly is set`,
      );
    }
    if (change.kind === "override" && constraints.preferVersionBump) {
      violations.push(`${label}: an override, but preferVersionBump rejects overrides`);
    }
    const from = change.from === undefined ? undefined : versionOf(change.from.split("=").at(-1)!);
    const to = versionOf(change.to.split("=").at(-1)!);
    if (from && to && semver.major(to) > semver.major(from) && !context.policy.allowMajorBumps) {
      violations.push(`${label}: a major bump, but allowMajorBumps is off`);
    }
  }
  return violations.length > 0
    ? fail(`${violations.length} change(s) the policy does not allow`, violations)
    : pass(`${context.changes().length} dependency change(s) allowed by policy`);
};

/** Every version the change introduces passes the supply-chain gate (age, scripts, provenance). */
const supplyChain: CheckFn = async (context) => {
  if (context.options.offline) return skip("offline: the registry is not consulted");
  const constraints = constraintsOf(context);
  const cooldown = readCooldown(context.request.cwd, context.packageManager);
  const registry = loadRegistryConfig(context.request.cwd);

  const problems: string[] = [];
  let checked = 0;
  for (const change of context.changes()) {
    if (change.to === undefined) continue;
    const version = versionOf(change.to.split("=").at(-1)!);
    if (!version) continue;
    const policy = withCooldown(constraints.supplyChainPolicy, cooldown, change.name);
    const verdict = await verifyPackageTrust(change.name, version, policy, registry);
    checked += 1;
    if (!verdict.trusted) problems.push(`${change.name}@${version}: ${verdict.reason}`);
  }
  return problems.length > 0
    ? fail(`${problems.length} version(s) fail the supply-chain gate`, problems)
    : pass(
        checked === 0
          ? "no new versions to check"
          : `${checked} new version(s) pass the supply-chain gate`,
      );
};

/** A frozen install succeeds: the lockfile agrees with the manifests the change left behind. */
const install: CheckFn = async (context) => {
  const yarnMajor =
    context.packageManager === "yarn" ? await getYarnMajorVersion(context.request.cwd) : undefined;
  const command = resolveInstallCommand(
    context.packageManager,
    { ...constraintsOf(context), enforceFrozenLockfile: true },
    yarnMajor,
  );
  const outcome = await runCommandCheck(command, context.request.cwd);
  return outcome.passed
    ? pass(`${command.join(" ")} succeeded`)
    : fail(
        `${command.join(" ")} failed: the lockfile does not match the manifests`,
        tail(outcome.output),
      );
};

/** None of the advisories still matches an installed package, except the ones knowingly left. */
const vulnGone: CheckFn = async (context) => {
  if (context.request.advisories.length === 0) return skip("no advisory to check against");

  const inventory = await context.inventory();
  if ("error" in inventory)
    return fail("the installed packages could not be listed", [inventory.error]);

  const allowed = new Set(context.request.expectedRemaining ?? []);
  const remaining: string[] = [];
  for (const advisory of context.request.advisories) {
    for (const vulnerable of findVulnerablePackages(advisory, inventory.packages)) {
      if (allowed.has(vulnerable.installed.name)) continue;
      remaining.push(
        `${vulnerable.installed.name}@${vulnerable.installed.version} is still in ${vulnerable.affected.vulnerableRange} (${advisory.id})`,
      );
    }
  }
  return remaining.length > 0
    ? fail(`${remaining.length} vulnerable package(s) remain`, remaining)
    : pass(
        `no vulnerable copy of the ${context.request.advisories.length} advisory package(s) remains`,
      );
};

const typecheck: CheckFn = async (context) => {
  const requested = context.options.typecheck ?? constraintsOf(context).typecheck;
  if (!requested) return skip("not requested");
  const command = resolveTypecheckCommand(
    context.packageManager,
    constraintsOf(context),
    context.request.cwd,
  );
  if (command.length === 0) return skip("no typecheck script or tsconfig found");
  const outcome = await runCommandCheck(command, context.request.cwd);
  return outcome.passed
    ? pass(`${command.join(" ")} succeeded`)
    : fail(`${command.join(" ")} failed`, tail(outcome.output));
};

const tests: CheckFn = async (context) => {
  if (!context.options.runTests) return skip("not requested");
  const command = resolveProjectTestCommand(
    context.packageManager,
    constraintsOf(context),
    context.request.cwd,
  );
  const outcome = await runCommandCheck(command, context.request.cwd);
  return outcome.passed
    ? { ...pass(`${command.join(" ")} passed`), command }
    : fail(`${command.join(" ")} failed`, tail(outcome.output));
};

/** The reproduction test, run now, passes. (That it failed before is established when it is written.) */
const proofOfFix: CheckFn = async (context) => {
  const { proofOfFix: proof, reproductionTest, requireProofOfFix, patchesDir } = context.options;
  const required = requireProofOfFix ?? constraintsOf(context).requireProofOfFix;
  if (!proof && !reproductionTest) {
    return required
      ? fail("proof of fix is required, but no reproduction test was supplied")
      : skip("no reproduction test supplied");
  }

  const prepared = await prepareReproductionTestFile({
    cwd: context.request.cwd,
    packageName: "verify",
    vulnerableVersion: "0.0.0",
    patchesDir,
    proofOfFix: proof,
    reproductionTest,
  });
  if (!prepared.testFilePath)
    return required
      ? fail("the reproduction test could not be found")
      : skip("no reproduction test found");

  const phase = await runProofOfFixPhase({
    stage: "positive",
    testFilePath: prepared.testFilePath,
    cwd: context.request.cwd,
  });
  return phase.passed
    ? pass("the reproduction test passes")
    : fail("the reproduction test still fails", phase.error ? [phase.error] : undefined);
};

export const CHECKS: Record<CheckName, CheckFn> = {
  scope,
  policy: policyCheck,
  "supply-chain": supplyChain,
  install,
  "vuln-gone": vulnGone,
  typecheck,
  tests,
  "proof-of-fix": proofOfFix,
};
