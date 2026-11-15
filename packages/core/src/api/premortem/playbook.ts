import { code, prose } from "../incident/markdown.js";
import { stripControl } from "../incident/text.js";
import type { PackageBlastRadius, PlaybookKind, PremortemRepo, PremortemReport } from "./types.js";

/** Quote a value for a POSIX shell. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const scripts = (value: boolean | "unknown"): string =>
  value === "unknown" ? "unknown" : value ? "**yes**" : "no";

const INTRO =
  "A rehearsal document, written before anything went wrong. It lists what depends on the packages that matter most and the exact commands to run on the day one of them is reported compromised. It is generated from lockfiles, CI files and installed manifests; regenerate it with `autoremediator premortem` when dependencies change.";

function incidentCommands(packageName: string, versions: string[], path: string): string[] {
  // A path with control characters or a backtick could break out of the code fence; it cannot be a command anyway.
  const cwd = stripControl(path, "?").replaceAll("`", "?");
  const dir = `incident-${packageName.replaceAll(/[^a-z0-9]+/gi, "-").replaceAll(/^-+|-+$/g, "")}`;
  return [
    `# When an advisory names the bad versions (an id such as MAL-… or GHSA-…, or a range):`,
    `autoremediator incident '<advisory id>' --cwd ${shellQuote(cwd)} --output-dir ${shellQuote(`./${dir}`)}`,
    `autoremediator incident ${shellQuote(`${packageName}@<affected range>`)} --cwd ${shellQuote(cwd)} --output-dir ${shellQuote(`./${dir}`)}`,
    ...(versions.length > 0
      ? [
          `# If the version you have now is the one reported:`,
          `autoremediator incident ${shellQuote(`${packageName}@${versions[0]}`)} --cwd ${shellQuote(cwd)} --output-dir ${shellQuote(`./${dir}`)}`,
        ]
      : []),
  ];
}

const DAY_STEPS = [
  "Run the incident command for the package. It reads the lockfiles and git history and writes `incident-report.md` and `incident-report.json`; it changes nothing.",
  "Read the exposure and history sections: which versions were locked, since when, on which branches and tags. Check your CI and deployment logs for builds of those commits; git does not know what was deployed.",
  "Add `--plan` to record a rollback to the last safe version as a plan, review it with `autoremediator runs show <runId>`, then `autoremediator runs apply <runId>`. It is never applied without that step.",
  "Work through the rotation checklist in the report. It is a list to review, not a finding of compromise.",
  "Rebuild from a clean checkout and clear CI caches once the lockfile is back on a safe version.",
];

function repoSection(repo: PremortemRepo, report: PremortemReport): string[] {
  const lines: string[] = [
    `## ${prose(repo.label)}`,
    "",
    `Path: ${code(repo.cwd)}. Lockfiles: ${repo.lockfiles.length > 0 ? repo.lockfiles.map((file) => code(file)).join(", ") : "none readable"}.`,
    "",
  ];
  const used = report.packages.filter((entry) =>
    entry.usage.some((usage) => usage.repo === repo.label),
  );
  if (used.length === 0) {
    lines.push("None of the assessed packages is locked here.", "");
    return lines;
  }
  lines.push(
    "| Package | Versions | How | Scope | Install scripts |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const entry of used) {
    const usage = entry.usage.find((candidate) => candidate.repo === repo.label)!;
    lines.push(
      `| ${code(entry.packageName)} | ${usage.versions.map((version) => code(version)).join(", ")} | ${usage.direct ? "direct" : "transitive"} | ${usage.scope} | ${scripts(usage.installScript)} |`,
    );
  }
  lines.push("");
  if (repo.ci.installs) {
    lines.push(
      `CI installs dependencies (${repo.ci.files.map((file) => code(file)).join(", ")})${
        repo.ci.secretNames.length > 0
          ? ` with these secrets in reach: ${repo.ci.secretNames.map((name) => code(name)).join(", ")}`
          : ""
      }. These names are what to rotate first if a bad version was installed by a build.`,
      "",
    );
  } else {
    lines.push("No CI workflow or container build that installs dependencies was found.", "");
  }
  return lines;
}

function packageSection(entry: PackageBlastRadius, report: PremortemReport): string[] {
  const lines: string[] = [
    `## ${code(entry.packageName)}`,
    "",
    `Locked in ${entry.repoCount} of ${report.repos.length} repositories; ${entry.dependentCount} package(s) depend on it. Install scripts: ${scripts(entry.installScript)}.`,
    "",
  ];
  if (entry.usage.length === 0) {
    lines.push("Not locked in any repository read.", "");
    return lines;
  }
  lines.push(
    "| Repository | Versions | How | Scope | CI installs with secrets |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const usage of entry.usage) {
    lines.push(
      `| ${prose(usage.repo)} | ${usage.versions.map((version) => code(version)).join(", ")} | ${usage.direct ? "direct" : "transitive"} | ${usage.scope} | ${entry.reposWithCiSecrets.includes(usage.repo) ? "**yes**" : "no"} |`,
    );
  }
  lines.push("");
  return lines;
}

/** One playbook: for a repository (`subject` is its label) or for a package (its name). */
export function renderPlaybook(
  report: PremortemReport,
  kind: PlaybookKind,
  subject: string,
): string {
  const out: string[] = [];
  const day = report.generatedAt.slice(0, 10);

  if (kind === "repo") {
    const repo = report.repos.find((candidate) => candidate.label === subject)!;
    out.push(
      `# Supply-chain incident playbook: ${prose(repo.label)}`,
      "",
      `Generated ${day}. ${INTRO}`,
      "",
      "## What to watch",
      "",
    );
    out.push(...repoSection(repo, report).slice(2));
    out.push(
      "## On the day",
      "",
      ...DAY_STEPS.map((step, index) => `${index + 1}. ${step}`),
      "",
      "## Commands",
      "",
    );
    const used = report.packages.filter((entry) =>
      entry.usage.some((usage) => usage.repo === repo.label),
    );
    if (used.length === 0)
      out.push(
        "Nothing assessed is locked here; use the commands below if a package you did not list is reported.",
        "",
      );
    for (const entry of used) {
      const usage = entry.usage.find((candidate) => candidate.repo === repo.label)!;
      out.push(
        `### ${code(entry.packageName)}`,
        "",
        "```sh",
        ...incidentCommands(entry.packageName, usage.versions, repo.cwd),
        "```",
        "",
      );
    }
  } else {
    const entry = report.packages.find((candidate) => candidate.packageName === subject)!;
    out.push(
      `# Supply-chain incident playbook: ${code(entry.packageName)}`,
      "",
      `Generated ${day}. ${INTRO}`,
      "",
      ...packageSection(entry, report).slice(2),
    );
    out.push(
      "## On the day",
      "",
      ...DAY_STEPS.map((step, index) => `${index + 1}. ${step}`),
      "",
      "## Commands, per repository",
      "",
    );
    for (const usage of entry.usage) {
      const repo = report.repos.find((candidate) => candidate.label === usage.repo)!;
      out.push(
        `### ${prose(usage.repo)}`,
        "",
        "```sh",
        ...incidentCommands(entry.packageName, usage.versions, repo.cwd),
        "```",
        "",
      );
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** The index page: the blast radius of every assessed package, and a link to each playbook. */
export function renderPremortemSummary(
  report: PremortemReport,
  kind: PlaybookKind,
  link: (subject: string) => string,
): string {
  const out: string[] = [
    "# Compromise pre-mortem",
    "",
    `Generated ${report.generatedAt}. ${INTRO}`,
    "",
  ];
  out.push(
    report.selection.mode === "given"
      ? `Assessed the packages you named, across ${report.repos.length} repositories.`
      : `Assessed the ${report.packages.length} ${report.selection.rankBy === "privileged" ? "most privileged (install scripts first)" : "most depended-upon"} packages across ${report.repos.length} repositories.`,
    "",
  );
  out.push(
    "| Package | Repositories | Depended on by | Install scripts | CI installs with secrets in |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const entry of report.packages) {
    out.push(
      `| ${code(entry.packageName)} | ${entry.repoCount} | ${entry.dependentCount} | ${scripts(entry.installScript)} | ${entry.reposWithCiSecrets.length > 0 ? entry.reposWithCiSecrets.map((repo) => prose(repo)).join(", ") : "none"} |`,
    );
  }
  out.push("", "## Playbooks", "");
  const subjects =
    kind === "repo"
      ? report.repos.map((repo) => repo.label)
      : report.packages.map((entry) => entry.packageName);
  for (const subject of subjects) out.push(`- [${prose(subject)}](${link(subject)})`);
  out.push("");
  if (report.notes.length > 0) {
    out.push("## Notes", "", ...report.notes.map((note) => `- ${prose(note)}`), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
