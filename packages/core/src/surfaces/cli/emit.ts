/**
 * Printing a scan-shaped report and setting the exit code, in one place. Every command that
 * reports on remediation picks its output the same way: `--output-format sarif`, `cyclonedx-vex`
 * or `json` print machine-readable output, anything else prints the command's own text, and
 * `--ci` turns the outcome into the exit code.
 */
import {
  ciExitCode,
  proofEvidenceRefs,
  toCiSummary,
  toCycloneDxVex,
  toSarifOutput,
  type ScanReport,
} from "../../api/index.js";
import { PACKAGE_VERSION } from "../../shared/version.js";
import { logJson } from "./output.js";
import type { CommandOptions } from "./types.js";

export interface ScanReportOutput {
  /** What SARIF, VEX and the CI summary are computed from. */
  scan: ScanReport;
  /** What `--output-format json` prints. */
  json: unknown;
  /** What the default output prints, one entry per line. */
  text: () => string[];
}

export function emitScanReport(
  opts: Pick<CommandOptions, "outputFormat" | "ci" | "cwd" | "patchesDir">,
  { scan, json, text }: ScanReportOutput,
): void {
  if (opts.outputFormat === "sarif") {
    logJson(toSarifOutput(scan));
  } else if (opts.outputFormat === "cyclonedx-vex") {
    logJson(
      toCycloneDxVex(scan, {
        toolVersion: PACKAGE_VERSION,
        proofEvidence: proofEvidenceRefs(opts.cwd, opts.patchesDir),
      }),
    );
  } else if (opts.outputFormat === "json") {
    logJson(json);
  } else {
    for (const line of text()) process.stdout.write(`${line}\n`);
  }
  if (opts.ci) process.exitCode = ciExitCode(toCiSummary(scan));
}
