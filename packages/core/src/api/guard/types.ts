export type GuardCheck =
  | "spec"
  | "exists"
  | "malware"
  | "typosquat"
  | "cooldown"
  | "install-scripts"
  | "provenance"
  | "deprecated"
  | "vulnerabilities"
  | "registry";

/** `block`: do not install. `warn`: a person should look first. `info`: worth knowing. */
export type GuardSeverity = "block" | "warn" | "info";
export type GuardVerdict = "allow" | "warn" | "block";

export interface GuardFinding {
  check: GuardCheck;
  severity: GuardSeverity;
  message: string;
}

export interface GuardAlternative {
  packageName: string;
  version?: string;
  reason: string;
}

export interface GuardReport {
  schemaVersion: "1.0";
  /** What was asked about, as given. */
  spec: string;
  packageName?: string;
  /** The version the spec would install. */
  resolvedVersion?: string;
  verdict: GuardVerdict;
  findings: GuardFinding[];
  alternative?: GuardAlternative;
  generatedAt: string;
}

export interface GuardOptions {
  cwd?: string;
  /** Block releases younger than this many hours. Default 72; 0 turns the check off. */
  minPublishAgeHours?: number;
  /** Skip the OSV malware and advisory lookups (the verdict then says they were not checked). */
  offline?: boolean;
}
