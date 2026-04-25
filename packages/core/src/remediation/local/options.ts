import { resolveProvider } from "../../platform/config.js";
import { loadPolicy } from "../../platform/policy.js";
import type {
  EscalationGraph,
  ExploitSignalOverridePolicy,
  PatchConfidenceThresholds,
  RemediateOptions,
  SlaPolicy,
  VexSuppression,
} from "../../platform/types.js";
import { detectPackageManager } from "../../platform/package-manager/index.js";

export interface LocalRunOptions {
  cwd: string;
  packageManager: "npm" | "pnpm" | "yarn";
  preview: boolean;
  dryRun: boolean;
  runTests: boolean;
  policy: string;
  patchesDir: string;
  constraints: NonNullable<RemediateOptions["constraints"]>;
  llmProvider: "remote" | "local";
  providerSafetyProfile: "strict" | "relaxed";
  requireConsensusForHighRisk: boolean;
  consensusProvider: "remote" | "local";
  consensusModel?: string;
  patchConfidenceThresholds?: PatchConfidenceThresholds;
  dynamicModelRouting: boolean;
  dynamicRoutingThresholdChars?: number;
  exploitSignalOverride?: ExploitSignalOverridePolicy;
  suppressions: VexSuppression[];
  suppressionsFile?: string;
  slaCheck: boolean;
  slaPolicy?: SlaPolicy;
  skipUnreachable: boolean;
  regressionCheck: boolean;
  escalationGraph?: EscalationGraph;
}

export function resolveLocalRunOptions(options: RemediateOptions): LocalRunOptions {
  const cwd = options.cwd ?? process.cwd();
  const packageManager = options.packageManager ?? detectPackageManager(cwd);
  const preview = options.preview ?? false;
  const dryRun = (options.dryRun ?? false) || preview;
  const runTests = options.runTests ?? false;
  const policy = options.policy ?? "";
  const patchesDir = options.patchesDir || "./patches";
  const constraints = options.constraints ?? {};
  const loadedPolicy = loadPolicy(cwd, options.policy);
  const llmProvider = resolveProvider(options);

  return {
    cwd,
    packageManager,
    preview,
    dryRun,
    runTests,
    policy,
    patchesDir,
    constraints,
    llmProvider,
    providerSafetyProfile:
      options.providerSafetyProfile ?? loadedPolicy.providerSafetyProfile ?? "relaxed",
    requireConsensusForHighRisk:
      options.requireConsensusForHighRisk ?? loadedPolicy.requireConsensusForHighRisk ?? false,
    consensusProvider: options.consensusProvider ?? loadedPolicy.consensusProvider ?? "remote",
    consensusModel: options.consensusModel ?? loadedPolicy.consensusModel,
    patchConfidenceThresholds: {
      ...loadedPolicy.patchConfidenceThresholds,
      ...options.patchConfidenceThresholds,
    },
    dynamicModelRouting: options.dynamicModelRouting ?? loadedPolicy.dynamicModelRouting ?? false,
    dynamicRoutingThresholdChars:
      options.dynamicRoutingThresholdChars ?? loadedPolicy.dynamicRoutingThresholdChars,
    exploitSignalOverride: options.exploitSignalOverride ?? loadedPolicy.exploitSignalOverride,
    suppressions: loadedPolicy.suppressions ?? [],
    suppressionsFile: options.suppressionsFile,
    slaCheck: options.slaCheck ?? false,
    slaPolicy: loadedPolicy.sla,
    skipUnreachable: options.skipUnreachable ?? loadedPolicy.skipUnreachable ?? false,
    regressionCheck: options.regressionCheck ?? false,
    escalationGraph: options.escalationGraph ?? loadedPolicy.escalationGraph,
  };
}
