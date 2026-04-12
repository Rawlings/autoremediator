import { remediateFromScan, type ScanReport } from "autoremediator";
import type { RemediationTriggerContext } from "./types.js";

export interface DefaultRemediationHandlerOptions {
  cwd?: string;
  dryRun?: boolean;
}

export type RemediationHandler = (context: RemediationTriggerContext) => Promise<void>;

export function createDefaultRemediationHandler(options: DefaultRemediationHandlerOptions = {}): RemediationHandler {
  const cwd = options.cwd ?? process.cwd();
  const dryRun = options.dryRun ?? true;

  return async (context: RemediationTriggerContext): Promise<void> => {
    if (context.eventName !== "check_suite" && context.eventName !== "workflow_dispatch") {
      return;
    }

    const report: ScanReport = await remediateFromScan("", {
      cwd,
      audit: true,
      dryRun,
    });

    void report;
  };
}