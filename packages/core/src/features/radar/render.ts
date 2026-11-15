import type { RadarEntry, RadarReport } from "./types.js";

const FLAGS_SHOWN = 4;

function flagLines(entry: RadarEntry): string[] {
  const shown = entry.flags.slice(0, FLAGS_SHOWN);
  const lines = shown.map(
    (flag) =>
      `     ${flag.category.padEnd(9)} +${String(flag.points).padEnd(3)} ${flag.signal} (${flag.release}${
        flag.occurrences > 1 ? `, ${flag.occurrences} places` : ""
      })\n       ${flag.evidence}`,
  );
  if (entry.flags.length > shown.length)
    lines.push(`     ... and ${entry.flags.length - shown.length} more signal(s)`);
  return lines;
}

/** Plain-text report. Evidence is untrusted text from packages, already sanitized to one short line. */
export function renderRadar(report: RadarReport): string {
  const lines = [
    `Silent-fix radar (target: ${report.target}${report.includeTransitive ? ", including transitive dependencies" : ""})`,
    `${report.analysed} package(s) compared: ${report.flagged} flagged, ${report.clean} clean; ${report.upToDate} already at the target; ${report.skipped.length} skipped.`,
    "",
  ];
  if (report.entries.length === 0) {
    lines.push(
      "Nothing security-relevant stood out in the releases between your versions and the target.",
    );
  }
  for (const [index, entry] of report.entries.entries()) {
    const tag =
      entry.status === "now-advisory"
        ? `advisory now exists: ${entry.advisories.map((advisory) => advisory.id).join(", ")}`
        : entry.status === "unchecked"
          ? "advisories unchecked"
          : "no published advisory";
    lines.push(
      `${index + 1}. ${entry.name} ${entry.installed} -> ${entry.target} (${entry.upgrade}${entry.direct ? "" : ", transitive"})  ${entry.confidence}  score ${entry.score}  [${tag}]`,
      `   ${entry.statement}`,
      ...flagLines(entry),
    );
    if (entry.impact)
      lines.push(`   upgrade impact: ${entry.impact.rating} - ${entry.impact.summary}`);
    for (const note of entry.notes) lines.push(`   note: ${note}`);
    lines.push("");
  }
  if (report.flagged > report.entries.length) {
    lines.push(
      `${report.flagged - report.entries.length} more flagged package(s) not shown (raise the limit).`,
      "",
    );
  }
  for (const skipped of report.skipped.slice(0, 10)) {
    lines.push(
      `skipped ${skipped.name}${skipped.version ? `@${skipped.version}` : ""}: ${skipped.reason}`,
    );
  }
  if (report.skipped.length > 10) lines.push(`... and ${report.skipped.length - 10} more skipped`);
  for (const note of report.notes) lines.push(`note: ${note}`);
  lines.push("", report.disclaimer);
  return `${lines.join("\n")}\n`;
}

/** `3` when a `likely` change without an advisory was found, else `0`. */
export function radarExitCode(report: RadarReport): number {
  return report.entries.some(
    (entry) => entry.confidence === "likely" && entry.status !== "now-advisory",
  )
    ? 3
    : 0;
}
