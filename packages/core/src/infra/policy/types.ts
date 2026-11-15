import type { CveSeverity, UnresolvedReason } from "../../shared/types.js";

export type PatchRiskLevel = "low" | "medium" | "high";

export type PatchConfidenceThresholds = Partial<Record<PatchRiskLevel, number>>;

export interface ExploitSignalOverridePolicy {
  kev?: { mandatory: boolean };
  epss?: { mandatory: boolean; threshold: number };
}

export interface SlaPolicy {
  critical?: number; // hours
  high?: number;
  medium?: number;
  low?: number;
}

export type EscalationAction =
  | "open-issue"
  | "notify-channel"
  | "create-draft-pr"
  | "hold-branch"
  | "none";

export type EscalationGraph = Partial<Record<UnresolvedReason, EscalationAction>>;

export interface DispositionPolicy {
  minConfidenceForAutoApply?: number;
  holdForTransitive?: boolean;
  escalateOnSlaBreachSeverities?: CveSeverity[];
  escalateOnKev?: boolean;
}

export interface SupplyChainPolicy {
  /** Minimum age of package version release in hours (e.g. 48 or 72) */
  minPublishAgeHours?: number;
  /** Where `minPublishAgeHours` came from when it is not the policy file (e.g. the package manager's own setting). */
  minPublishAgeSource?: string;
  /** Block versions that define preinstall or postinstall scripts */
  blockInstallScripts?: boolean;
  /** Require cryptographic provenance attestation (Sigstore / GitHub Actions build attestations) */
  requireProvenance?: boolean;
}

export interface RemediationConstraints {
  directDependenciesOnly?: boolean;
  preferVersionBump?: boolean;
  installMode?: "standard" | "prefer-offline" | "deterministic";
  installPreferOffline?: boolean;
  enforceFrozenLockfile?: boolean;
  /**
   * Whether lifecycle scripts (preinstall/install/postinstall) of dependencies run during installs
   * this tool starts. Default "none". Read from the policy file only; never accepted from a caller.
   */
  installScripts?: "none" | "all";
  workspace?: string;
  typecheck?: boolean;
  supplyChainPolicy?: SupplyChainPolicy;
  requireProofOfFix?: boolean;
  enableBreakingChangeRefactor?: boolean;
}

export type VexJustification = "not_affected" | "fixed" | "mitigated" | "under_investigation";

export interface VexSuppression {
  cveId: string;
  justification: VexJustification;
  notes?: string;
  expiresAt?: string; // ISO 8601 date string
}
