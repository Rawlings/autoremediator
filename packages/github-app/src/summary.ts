import type { ScanReport } from "autoremediator";

/** Markdown for a comment: what a run did, and what it could not do. */
export function summarizeScanReport(report: ScanReport, mode: "plan" | "fix"): string {
  const lines: string[] = [
    mode === "plan" ? "**Autoremediator plan** (nothing was changed)" : "**Autoremediator result**",
    "",
  ];
  let rows = 0;
  for (const cveReport of report.reports) {
    for (const result of cveReport.results) {
      rows += 1;
      const change = result.toVersion
        ? `${result.fromVersion} -> ${result.toVersion}`
        : result.fromVersion;
      const outcome = result.applied
        ? "fixed"
        : result.dryRun
          ? "would fix"
          : `not fixed: ${result.unresolvedReason ?? "unknown"}`;
      lines.push(
        `- ${cveReport.cveId}: \`${result.packageName}\` ${change} (${result.strategy}), ${outcome}`,
      );
    }
  }
  if (rows === 0) lines.push("No vulnerable installed packages were found for those advisories.");
  for (const error of report.errors.slice(0, 5)) {
    lines.push(`- ${error.cveId}: error: ${error.message.slice(0, 200)}`);
  }
  const requests = report.changeRequests ?? [];
  for (const request of requests) {
    if (request.url)
      lines.push("", `Pull request: ${request.url}${request.updated ? " (updated)" : ""}`);
    else if (request.error)
      lines.push("", `Pull request not created: ${request.error.slice(0, 200)}`);
  }
  return lines.join("\n");
}
