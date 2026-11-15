import type { CraDeadlines } from "./cra.js";
import type { VexStatus } from "./findings.js";

export interface EvidencePackFile {
  /** Relative to the pack directory, with `/`. */
  path: string;
  sha256: string;
  bytes: number;
  kind:
    | "readme"
    | "sbom"
    | "vex"
    | "cra-draft"
    | "attestation"
    | "statement"
    | "public-key"
    | "manifest";
}

export interface EvidencePackResult {
  schemaVersion: "1";
  outDir: string;
  generatedAt: string;
  disclaimer: string;
  /** Whether the attestations carry a signature. `false` means the envelopes have an empty `signatures` list. */
  signed: boolean;
  signingKeyId?: string;
  signingAlgorithm?: string;
  /** Every file written, except the manifest and the pack attestation, which `manifest` and `packAttestation` name. */
  files: EvidencePackFile[];
  manifest: EvidencePackFile;
  packAttestation: { envelope: string; statement: string; signed: boolean; manifestSha256: string };
  sbom: {
    file: string;
    specVersion: "1.6";
    source: string;
    components: number;
    withHash: number;
    withLicense: number;
  };
  vex: {
    cycloneDxFile: string;
    openVexFile: string;
    statements: number;
    byStatus: Record<VexStatus, number>;
  };
  craReports: Array<{
    cveId: string;
    file: string;
    status: VexStatus;
    deadlines?: CraDeadlines;
  }>;
  attestations: Array<{
    runId: string;
    runStatus: string;
    envelope: string;
    statement: string;
    signed: boolean;
    ledgerHead: string;
  }>;
  skippedRuns: Array<{ runId: string; reason: string }>;
  notes: string[];
}
