import type { RefSet, VersionWindow } from "./history.js";
import { stripControl } from "./text.js";
import type { IncidentReport, Occurrence } from "./types.js";

/** Strip control characters, so one untrusted string cannot become several lines of markdown. */
const flat = (value: string): string => stripControl(value).trim();

/** Inline code. Backticks inside become quotes, and pipes are escaped so a table cell cannot be split. */
export const code = (value: string): string =>
  `\`${flat(value)
    .replaceAll("`", "'")
    .replaceAll("|", String.raw`\|`)}\``;

/** Plain prose from an untrusted source: no markup, no HTML. */
export const prose = (value: string): string =>
  flat(value).replaceAll(/[\\`*_{}[\]<>#|]/g, (char) => `\\${char}`);

const short = (sha: string): string => sha.slice(0, 10);
const day = (iso: string): string => iso.slice(0, 10);
const commitText = (commit: { sha: string; date: string }): string =>
  `${code(short(commit.sha))} (${day(commit.date)})`;
const list = (values: string[], limit = 12): string =>
  values.length === 0
    ? "none"
    : `${values
        .slice(0, limit)
        .map((value) => code(value))
        .join(", ")}${values.length > limit ? `, and ${values.length - limit} more` : ""}`;
const refs = (set: RefSet): string =>
  [
    set.branches.length > 0 ? `branches ${list(set.branches)}` : "",
    set.tags.length > 0 ? `tags ${list(set.tags)}` : "",
  ]
    .filter((part) => part !== "")
    .join("; ") || "none";

function occurrenceRow(name: string, occurrence: Occurrence): string {
  const kind = occurrence.direct
    ? `direct (${occurrence.workspaces.map((ws) => code(ws)).join(", ")})`
    : "transitive";
  const via =
    occurrence.via.length > 0
      ? occurrence.via.map((hop) => code(hop)).join(" → ")
      : "nothing the manifests ask for leads here";
  const scripts =
    occurrence.installScript === "unknown"
      ? "unknown"
      : occurrence.installScript
        ? "**yes**"
        : "no";
  return `| ${code(`${name}@${occurrence.version}`)} | ${occurrence.scope} | ${kind} | ${via} | ${scripts} | ${code(occurrence.lockfile)} |`;
}

function windowLines(window: VersionWindow): string[] {
  const entered =
    window.entered.length > 0
      ? window.entered.map((commit) => commitText(commit)).join(", ")
      : "before the history that was read";
  const left =
    window.left.length > 0
      ? window.left.map((commit) => commitText(commit)).join(", ")
      : window.presentAtHead
        ? "**still present at HEAD**"
        : "not found leaving";
  return [
    `- ${code(window.version)} in ${code(window.lockfile)}`,
    `  - entered: ${entered}`,
    `  - left: ${left}`,
    ...(window.previousVersions.length > 0
      ? [`  - the lockfile had ${list(window.previousVersions, 3)} just before`]
      : []),
    `  - a build of these as they are now installs it: ${refs(window.atTip)}`,
    `  - history passes through the entering commit, but their tip no longer has it: ${refs(window.passedThrough)}`,
  ];
}

/** The incident report as markdown, safe to commit or paste into a ticket. */
export function renderIncidentMarkdown(report: IncidentReport): string {
  const out: string[] = [];
  const { target, exposure } = report;
  const out_ = (...lines: string[]): void => void out.push(...lines);

  out_(
    `# Incident report: ${code(target.input.length > 120 ? `${target.input.slice(0, 117)}...` : target.input)}`,
    "",
  );
  out_(`Generated ${report.generatedAt} for ${code(report.cwd)}.`, "");
  if (target.advisory) {
    out_(
      `**${prose(target.advisory.id)}** (${target.advisory.source}): ${prose(target.advisory.summary)}`,
      "",
    );
  }
  out_(
    "Affected: " +
      target.affected.map((entry) => `${code(entry.name)} ${code(entry.range)}`).join("; "),
    "",
  );

  const everPresent = report.history?.packages.some((entry) => entry.windows.length > 0) ?? false;
  out_("## Summary", "");
  out_(
    exposure.exposed
      ? "- **An affected version is locked or installed in this project now.**"
      : everPresent
        ? "- No affected version is locked now, but one was in this repository's history (see History)."
        : "- No affected version is locked here, and none was found in the lockfile history that was read.",
    "",
  );

  out_("## 1. Exposure now", "");
  const anyOccurrence = exposure.packages.some((entry) => entry.occurrences.length > 0);
  if (anyOccurrence) {
    out_(
      "| Package | Scope | How | Parent chain | Install scripts | Lockfile |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const entry of exposure.packages) {
      for (const occurrence of entry.occurrences)
        out_(occurrenceRow(entry.packageName, occurrence));
    }
    out_("");
  } else {
    out_("No affected version is in the lockfiles.", "");
  }
  for (const entry of exposure.packages) {
    if (entry.declared)
      out_(`- ${code(entry.packageName)} is declared in package.json as ${code(entry.declared)}.`);
    if (entry.installed && entry.installed.length > 0) {
      out_(
        `- Installed in node_modules: ${entry.installed.map((copy) => code(`${entry.packageName}@${copy.version}`)).join(", ")}.`,
      );
    }
  }
  for (const note of exposure.notes) out_(`- ${prose(note)}`);
  out_("");

  out_("## 2. History", "");
  if (!report.history) {
    out_("History was not read (turned off).", "");
  } else if (!report.history.available) {
    out_(`Not available: ${prose(report.history.reason ?? "no history")}.`, "");
  } else {
    out_(
      `Read ${report.history.scannedCommits} commit(s) that changed ${list(report.history.lockfiles)}.`,
      "Commits and dates are what the repository records. Which builds or deploys actually ran, and what they installed, is not known from git: check your CI and deployment logs for builds of the commits and refs below.",
      "",
    );
    for (const entry of report.history.packages) {
      out_(`### ${code(entry.packageName)}`, "");
      if (entry.windows.length === 0)
        out_("No affected version appears in the lockfile history.", "");
      for (const window of entry.windows) out_(...windowLines(window));
      if (entry.windows.length > 0) out_("");
      if (entry.manifestChanges.length > 0) {
        out_("package.json declared range changes:");
        for (const change of entry.manifestChanges.slice(0, 10)) {
          out_(
            `- ${commitText(change.commit)}: ${change.from ? code(change.from) : "(not listed)"} → ${change.to ? code(change.to) : "(removed)"}`,
          );
        }
        out_("");
      }
    }
    for (const note of report.history.notes) out_(`- ${prose(note)}`);
    if (report.history.unreadable > 0)
      out_(
        `- ${report.history.unreadable} lockfile version(s) could not be read and are not counted.`,
      );
    out_("");
  }

  out_("## 3. Roll back to the last safe version", "");
  if (report.rollback.proposals.length === 0) {
    out_("Nothing to roll back: no affected version is locked.", "");
  } else {
    out_("| Package | From | To | How | Basis |", "| --- | --- | --- | --- | --- |");
    for (const proposal of report.rollback.proposals) {
      out_(
        `| ${code(proposal.packageName)} | ${code(proposal.fromVersion)} | ${proposal.toVersion ? code(proposal.toVersion) : "**none known**"} | ${
          proposal.strategy === "version-bump"
            ? "exact pin in package.json"
            : "package-manager override"
        } | ${proposal.basis ?? prose(proposal.reason ?? "")} |`,
      );
    }
    out_("");
    for (const proposal of report.rollback.proposals) {
      if (proposal.newerUnaffected) {
        out_(
          `- A newer version outside the affected range exists for ${code(proposal.packageName)}: ${code(proposal.newerUnaffected)}. Moving forward is a separate decision.`,
        );
      }
    }
    if (report.rollback.plan) {
      out_(
        "",
        `Recorded as plan ${code(report.rollback.plan.planId)} (run ${code(report.rollback.plan.runId)}). Nothing has been changed. Review it, then apply it:`,
        "",
        "```sh",
        `autoremediator runs show ${report.rollback.plan.runId}`,
        `autoremediator runs apply ${report.rollback.plan.runId}`,
        "```",
      );
    } else {
      out_(
        "",
        "Not recorded. Run with `--plan` to record this as a plan that `autoremediator runs apply` can carry out after review.",
      );
    }
    out_("");
  }
  for (const note of report.rollback.notes) out_(`- ${prose(note)}`);
  if (report.rollback.notes.length > 0) out_("");

  if (report.secrets) {
    const secrets = report.secrets;
    out_("## 4. Rotation checklist", "", `> ${secrets.disclaimer}`, "");
    out_(
      "Any build or developer machine that ran an install while an affected version was locked had that environment in reach of the package's install scripts and code.",
      "",
    );
    if (secrets.secretNames.length > 0) {
      out_("Secret and credential names referenced (names only, no values were read):", "");
      for (const entry of secrets.secretNames) {
        out_(
          `- [ ] ${code(entry.name)}${entry.inInstallScope ? " (in reach of an install)" : ""} in ${list(entry.files, 4)}`,
        );
      }
      out_("");
    }
    for (const file of secrets.ci) {
      if (file.installs || file.installJobs.length > 0) {
        out_(
          `- CI ${code(file.file)} installs dependencies${file.installJobs.length > 0 ? ` in job(s) ${list(file.installJobs)}` : ""}.`,
        );
        for (const note of file.notes) out_(`  - ${prose(note)}`);
      }
    }
    for (const file of secrets.containers) {
      if (file.installs)
        out_(`- ${code(file.file)} installs dependencies while building an image.`);
    }
    for (const file of secrets.npmrc) {
      out_(
        `- ${code(file.file)}: ${file.envNames.length > 0 ? `reads ${list(file.envNames)}` : "no token variable"}${file.literalCredential ? "; **a credential is written into the file itself**" : ""}.`,
      );
    }
    for (const file of secrets.lifecycle)
      out_(`- ${code(file.file)} defines install-time scripts: ${list(file.scripts)}.`);
    out_("");
    out_("Generic steps:", "");
    for (const item of secrets.guidance) out_(`- [ ] ${item.text}`);
    out_("");
    for (const note of secrets.notes) out_(`- ${prose(note)}`);
    out_("");
  } else {
    out_(
      "## 4. Rotation checklist",
      "",
      "Not generated: the package was not found in this project's lockfiles or history.",
      "",
    );
  }

  if (report.notes.length > 0) {
    out_("## Notes", "");
    for (const note of report.notes) out_(`- ${prose(note)}`);
    out_("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
