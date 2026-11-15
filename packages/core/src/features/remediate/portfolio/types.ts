import type { RemediationConstraints } from "../../../infra/policy/types.js";
import type { CveSeverity } from "../../../shared/types.js";
import type { ChangeRequestResult } from "../../change-request/types.js";
import type {
  CorrelationContext,
  ProvenanceContext,
  RemediationReport,
  ScanReportLike,
  SlaBreachSummary,
} from "../types.js";

export interface PortfolioTarget {
  cwd: string;
  label?: string;
  cveId?: string;
  inputPath?: string;
  format?: "auto" | "npm-audit" | "yarn-audit" | "sarif";
  audit?: boolean;
  riskHint?: {
    severity?: CveSeverity;
    exploitSignal?: boolean;
    slaBreached?: boolean;
  };
}

export interface PortfolioTargetResult {
  target: PortfolioTarget;
  status: "ok" | "partial" | "failed";
  threatRank?: number;
  remediationReport?: RemediationReport;
  scanReport?: ScanReportLike;
  error?: string;
  changeRequests?: ChangeRequestResult[];
}

export interface PortfolioReport {
  schemaVersion: "1.0";
  status: "ok" | "partial" | "failed";
  generatedAt: string;
  targets: PortfolioTargetResult[];
  successCount: number;
  failedCount: number;
  changeRequests?: ChangeRequestResult[];
  slaBreachSummary?: SlaBreachSummary;
  correlation?: CorrelationContext;
  provenance?: ProvenanceContext;
  constraints?: RemediationConstraints;
}
