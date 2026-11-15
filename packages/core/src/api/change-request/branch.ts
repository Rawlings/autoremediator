import { createHash } from "node:crypto";

import { trimChar } from "../../platform/trim.js";
import type { RemediationReport } from "../../platform/types.js";

/** Make text safe as part of a git ref: no `..`, no leading dots, no `.lock` endings, no odd characters. */
function refSafe(value: string, allowSlash: boolean): string {
  const pattern = allowSlash ? /[^a-z0-9._/-]+/g : /[^a-z0-9._-]+/g;
  return value
    .toLowerCase()
    .replaceAll(pattern, "-")
    .replaceAll(/\.{2,}/g, ".")
    .split("/")
    .map((segment) => trimChar(trimChar(segment, "-"), ".").replace(/\.lock$/, ""))
    .filter(Boolean)
    .join("/");
}

function token(value: string, max = 60): string {
  return refSafe(value, false).slice(0, max);
}

/**
 * The branch for a group of reports. It depends only on which CVEs and packages the group covers,
 * so running again for the same findings updates the same branch (and so the same pull request)
 * instead of opening a duplicate. One CVE in one package reads as `<prefix>/<cve>-<package>`;
 * anything larger is named by its first CVE and a short hash of the whole set.
 */
export function deterministicBranchName(
  prefix: string,
  cveIds: readonly string[],
  packageNames: readonly string[],
): string {
  const cves = [...new Set(cveIds.map((id) => id.toUpperCase()))].toSorted();
  const packages = [...new Set(packageNames)].toSorted();
  const safePrefix = refSafe(prefix, true).slice(0, 80) || "autoremediator";

  let name: string;
  if (cves.length === 1 && packages.length <= 1) {
    name = [token(cves[0]!), packages[0] ? token(packages[0].replaceAll("/", "-")) : ""]
      .filter(Boolean)
      .join("-");
  } else {
    const digest = createHash("sha256").update(JSON.stringify([cves, packages])).digest("hex").slice(0, 8);
    name = `${token(cves[0] ?? "remediation", 40)}-and-${Math.max(cves.length - 1, 0) + packages.length}-more-${digest}`;
  }
  return `${safePrefix}/${name || "remediation"}`;
}

/** Trailers appended to the commit message so history says which advisory, run and checks a commit came from. */
export function commitTrailers(reports: readonly RemediationReport[]): string[] {
  const trailers: string[] = [];
  const cveIds = [...new Set(reports.map((report) => report.cveId.toUpperCase()))].toSorted();
  // A freshness step fixes no advisory; its pseudo id only names the branch.
  for (const id of cveIds) if (!id.startsWith("FRESHNESS-")) trailers.push(`Fixes-CVE: ${id}`);

  const runIds = [...new Set(reports.map((report) => report.runId).filter((id): id is string => Boolean(id)))];
  for (const id of runIds) trailers.push(`Autoremediator-Run: ${id}`);

  // Claim verification only for phases that actually ran and passed in every applied result.
  const applied = reports.flatMap((report) => report.results).filter((result) => result.applied);
  const phaseSets = applied.map((result) => result.validationPhases ?? []);
  if (phaseSets.length > 0 && phaseSets.every((phases) => phases.length > 0 && phases.every((phase) => phase.passed))) {
    let common = new Set(phaseSets[0]!.map((phase) => phase.phase));
    for (const phases of phaseSets.slice(1)) {
      const names = new Set(phases.map((phase) => phase.phase));
      common = new Set([...common].filter((phase) => names.has(phase)));
    }
    if (common.size > 0) {
      trailers.push(`Verified-By: autoremediator (${[...common].toSorted().join(", ")})`);
    }
  }
  return trailers;
}

/** Commit message: the title, a blank line, then trailers. */
export function commitMessage(title: string, reports: readonly RemediationReport[]): string {
  const trailers = commitTrailers(reports);
  return trailers.length > 0 ? `${title}\n\n${trailers.join("\n")}` : title;
}
