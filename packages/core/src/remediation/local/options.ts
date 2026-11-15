import { getModelSpec } from "../../platform/config.js";
import { detectPackageManager } from "../../platform/package-manager/index.js";
import { loadPolicy } from "../../platform/policy.js";
import type {
  EscalationGraph,
  ExploitSignalOverridePolicy,
  PackageManager,
  PatchConfidenceThresholds,
  RemediateOptions,
  SlaPolicy,
  VexSuppression,
} from "../../platform/types.js";

export interface LocalRunOptions {
  cwd: string;
  packageManager: PackageManager;
  preview: boolean;
  dryRun: boolean;
  runTests: boolean;
  policy: string;
  patchesDir: string;
  constraints: NonNullable<RemediateOptions["constraints"]>;
  /** Language model spec (`provider:model`) used for the patch fallback, if any. */
  model?: string;
  patchConfidenceThresholds?: PatchConfidenceThresholds;
  exploitSignalOverride?: ExploitSignalOverridePolicy;
  suppressions: VexSuppression[];
  suppressionsFile?: string;
  slaCheck: boolean;
  slaPolicy?: SlaPolicy;
  skipUnreachable: boolean;
  /** Policy only: a maintainer's shipped `not_affected` VEX statement suppresses remediation. */
  trustMaintainerVex: boolean;
  escalationGraph?: EscalationGraph;
  offlineIntelligence: boolean;
  intelligenceSnapshotPath?: string;
  proofOfFix?: boolean | string;
  requireProofOfFix?: boolean;
  breakingChangeRefactor?: boolean;
  ignoreMemory: boolean;
}

export function resolveLocalRunOptions(options: RemediateOptions): LocalRunOptions {
  const cwd = options.cwd ?? process.cwd();
  const packageManager = options.packageManager ?? detectPackageManager(cwd);
  const preview = options.preview ?? false;
  const dryRun = (options.dryRun ?? false) || preview;
  const runTests = options.runTests ?? false;
  const policy = options.policy ?? "";
  const patchesDir = options.patchesDir || "./patches";
  const loadedPolicy = loadPolicy(cwd, options.policy);
  const constraints = {
    ...options.constraints,
    typecheck:
      options.typecheck ?? options.constraints?.typecheck ?? loadedPolicy.constraints?.typecheck,
    supplyChainPolicy:
      options.supplyChainPolicy ??
      options.constraints?.supplyChainPolicy ??
      loadedPolicy.constraints?.supplyChainPolicy,
    enableBreakingChangeRefactor:
      options.breakingChangeRefactor ??
      options.constraints?.enableBreakingChangeRefactor ??
      loadedPolicy.constraints?.enableBreakingChangeRefactor,
    requireProofOfFix:
      options.requireProofOfFix ??
      options.constraints?.requireProofOfFix ??
      loadedPolicy.constraints?.requireProofOfFix,
  };

  return {
    cwd,
    packageManager,
    preview,
    dryRun,
    runTests,
    policy,
    patchesDir,
    constraints,
    model: getModelSpec(options.model),
    patchConfidenceThresholds: {
      ...loadedPolicy.patchConfidenceThresholds,
      ...options.patchConfidenceThresholds,
    },
    exploitSignalOverride: options.exploitSignalOverride ?? loadedPolicy.exploitSignalOverride,
    suppressions: loadedPolicy.suppressions ?? [],
    suppressionsFile: options.suppressionsFile,
    slaCheck: options.slaCheck ?? false,
    slaPolicy: loadedPolicy.sla,
    skipUnreachable: options.skipUnreachable ?? loadedPolicy.skipUnreachable ?? false,
    trustMaintainerVex: loadedPolicy.trustMaintainerVex ?? false,
    escalationGraph: options.escalationGraph ?? loadedPolicy.escalationGraph,
    offlineIntelligence: options.offlineIntelligence ?? false,
    intelligenceSnapshotPath: options.intelligenceSnapshotPath,
    proofOfFix: options.proofOfFix,
    requireProofOfFix: options.requireProofOfFix ?? constraints.requireProofOfFix,
    breakingChangeRefactor:
      options.breakingChangeRefactor ?? constraints.enableBreakingChangeRefactor,
    ignoreMemory: options.ignoreMemory ?? false,
  };
}
