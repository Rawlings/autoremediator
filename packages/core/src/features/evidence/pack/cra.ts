import type { CveDetails } from "../../intelligence/types.js";
import type { VexFinding } from "./findings.js";
import type { ProductIdentity } from "./sbom.js";

/** Article 14(2) of Regulation (EU) 2024/2847: early warning within 24 hours of awareness. */
export const EARLY_WARNING_HOURS = 24;
/** Article 14(2)(b): vulnerability notification within 72 hours of awareness. */
export const NOTIFICATION_HOURS = 72;
/** Article 14(2)(c): final report no later than 14 days after a corrective or mitigating measure is available. */
export const FINAL_REPORT_DAYS = 14;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Parse an ISO 8601 timestamp that states its time zone. A timestamp without `Z` or an offset is
 * refused: a deadline computed from a guessed zone could be wrong by hours, and the deadlines are
 * the point.
 */
export function parseAwareness(value: string, label = "awarenessAt"): Date {
  const text = value.trim();
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      text,
    );
  if (!parts) {
    throw new Error(
      `${label} must be an ISO 8601 timestamp with a time zone, such as 2026-11-10T14:30:00Z or 2026-11-10T15:30:00+01:00 (got ${JSON.stringify(value)}).`,
    );
  }
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0] = [1, 2, 3, 4, 5].map((index) =>
    Number(parts[index]),
  );
  const second = parts[6] === undefined ? 0 : Number(parts[6]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const date = new Date(text);
  if (
    Number.isNaN(date.getTime()) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error(`${label} is not a real date and time: ${JSON.stringify(value)}.`);
  }
  return date;
}

export interface CraDeadlines {
  /** When the manufacturer became aware, as the caller stated it (UTC). */
  awarenessAt: string;
  /** Awareness plus 24 hours. */
  earlyWarningDue: string;
  /** Awareness plus 72 hours. */
  notificationDue: string;
  /** The corrective measure's availability plus 14 days; absent until that date is given. */
  finalReportDue?: string;
}

/** The three Article 14(2) deadlines, in UTC. Pure arithmetic on instants; no calendar or zone rules. */
export function craDeadlines(awareness: Date, correctiveMeasureAvailableAt?: Date): CraDeadlines {
  return {
    awarenessAt: awareness.toISOString(),
    earlyWarningDue: new Date(awareness.getTime() + EARLY_WARNING_HOURS * HOUR_MS).toISOString(),
    notificationDue: new Date(awareness.getTime() + NOTIFICATION_HOURS * HOUR_MS).toISOString(),
    ...(correctiveMeasureAvailableAt
      ? {
          finalReportDue: new Date(
            correctiveMeasureAvailableAt.getTime() + FINAL_REPORT_DAYS * DAY_MS,
          ).toISOString(),
        }
      : {}),
  };
}

export interface CraDraft {
  cveId: string;
  /** File name inside the pack's `cra-reports/` directory. */
  fileName: string;
  markdown: string;
  deadlines?: CraDeadlines;
  /** Why this advisory has a draft: CISA KEV lists it and the product's lockfile is affected. */
  status: VexFinding["status"];
}

/** A file name stem for an advisory id: letters, digits, dot, dash and underscore only. */
export function safeFileStem(id: string): string {
  const stem = id.replaceAll(/[^A-Za-z0-9._-]/g, "_").replaceAll(/\.{2,}/g, "_");
  return stem === "" || stem.startsWith(".") ? `advisory_${stem}` : stem;
}

const TODO = (what: string): string => `**[MANUFACTURER TO COMPLETE: ${what}]**`;

function productBlock(product: ProductIdentity): string[] {
  return [
    `- Product: ${product.name}${product.version ? ` ${product.version}` : ""}${product.purl ? ` (\`${product.purl}\`)` : ""}`,
    ...(product.description ? [`- Description (from package.json): ${product.description}`] : []),
    `- Manufacturer: ${product.manufacturer ?? TODO("legal name of the manufacturer")}`,
  ];
}

function advisoryBlock(cveId: string, details: CveDetails | null | undefined): string[] {
  const lines = [`- Advisory: ${cveId}`];
  if (!details) {
    lines.push(
      `- Advisory details: not available in the recorded runs. ${TODO("describe the vulnerability")}`,
    );
    return lines;
  }
  lines.push(
    `- Summary (from the advisory): ${details.summary}`,
    `- Severity: ${details.severity}${details.cvssScore === undefined ? "" : `, CVSS base score ${details.cvssScore}`}`,
  );
  if (details.affectedPackages.length > 0) {
    lines.push(
      `- Affected package${details.affectedPackages.length === 1 ? "" : "s"} (npm): ${details.affectedPackages
        .map(
          (pkg) =>
            `${pkg.name} ${pkg.vulnerableRange}${pkg.firstPatchedVersion ? ` (first patched: ${pkg.firstPatchedVersion})` : ""}`,
        )
        .join("; ")}`,
    );
  }
  return lines;
}

function kevBlock(details: CveDetails | null | undefined): string[] {
  const kev = details?.kev;
  if (!kev?.knownExploited) return [];
  return [
    "- CISA Known Exploited Vulnerabilities catalog: listed",
    ...(kev.dateAdded
      ? [
          `  - Added to the catalog: ${kev.dateAdded} (reference only; the CRA clock starts when *you* became aware, not on this date)`,
        ]
      : []),
    ...(kev.knownRansomwareCampaignUse
      ? [`  - Known ransomware campaign use (CISA's field): ${kev.knownRansomwareCampaignUse}`]
      : []),
    ...(kev.requiredAction ? [`  - CISA's required action: ${kev.requiredAction}`] : []),
  ];
}

function measuresBlock(findings: VexFinding[]): string[] {
  const lines: string[] = [];
  for (const finding of findings) {
    const where = finding.component
      ? `${finding.component.name}@${finding.component.version}`
      : "the product";
    lines.push(`- ${where}: ${finding.status.replaceAll("_", " ")}. ${finding.detail}`);
  }
  return lines.length > 0 ? lines : ["- No recorded run or policy entry describes a measure."];
}

/**
 * A markdown DRAFT of the three Article 14(2) reports for one actively exploited vulnerability,
 * filled in from local data. Everything the data cannot supply is marked for the manufacturer, and
 * nothing is submitted: reports go through the single reporting platform by hand.
 */
export function buildCraDraft(input: {
  cveId: string;
  details: CveDetails | null | undefined;
  findings: VexFinding[];
  product: ProductIdentity;
  awareness?: Date;
  correctiveMeasureAvailableAt?: Date;
  generatedAt: Date;
  toolVersion: string;
}): CraDraft {
  const { cveId, details, findings, product } = input;
  const deadlines = input.awareness
    ? craDeadlines(input.awareness, input.correctiveMeasureAvailableAt)
    : undefined;
  const status =
    findings.find((finding) => finding.status === "affected")?.status ?? findings[0]!.status;

  const due = (value: string | undefined, hours: string, what: string): string =>
    value
      ? `**Due: ${value}** (${what})`
      : `Due: ${TODO(`no awareness timestamp was given, so no deadline was computed; it is ${hours} after the moment you became aware`)}`;

  const finalDue = deadlines?.finalReportDue
    ? `**Due: ${deadlines.finalReportDue}** (corrective measure available + 14 days)`
    : `Due: ${TODO("the date a corrective or mitigating measure became available to users, plus 14 days; pass --corrective-measure-at <ISO 8601 with time zone> together with --awareness-at to compute it")}`;

  const lines: string[] = [
    `# DRAFT: Cyber Resilience Act Article 14 reports for ${cveId}`,
    "",
    "> **DRAFT. NOT SUBMITTED. NOT LEGAL ADVICE. NOT A COMPLIANCE CLAIM.**",
    "> autoremediator assembled this from files on this machine. It has not been reviewed by anyone, it",
    "> does not know whether this vulnerability is *actively exploited in the sense of the Regulation*",
    "> (Article 3(42): reliable evidence that a malicious actor exploited it without the system owner's",
    "> permission), and it submits nothing. Reports are made by the manufacturer through the single",
    "> reporting platform (Article 14(1), Article 16), to the CSIRT designated as coordinator and to",
    "> ENISA. Every field marked **[MANUFACTURER TO COMPLETE]** needs your input; check each filled-in",
    "> field against your own records before relying on it.",
    "",
    `Generated ${input.generatedAt.toISOString()} by autoremediator ${input.toolVersion}.`,
    "",
    "## Timeline",
    "",
    input.awareness
      ? `Awareness (as you stated it): ${deadlines!.awarenessAt}`
      : `Awareness: ${TODO("the moment the manufacturer became aware that this vulnerability is being actively exploited; pass --awareness-at <ISO 8601 with time zone> to compute the deadlines below")}`,
    "",
    "| Stage | Article | Due |",
    "| ----- | ------- | --- |",
    `| Early warning | 14(2)(a) | ${deadlines ? `${deadlines.earlyWarningDue} (awareness + 24 hours)` : "awareness + 24 hours"} |`,
    `| Vulnerability notification | 14(2)(b) | ${deadlines ? `${deadlines.notificationDue} (awareness + 72 hours)` : "awareness + 72 hours"} |`,
    `| Final report | 14(2)(c) | ${deadlines?.finalReportDue ? `${deadlines.finalReportDue} (corrective measure available + 14 days)` : "no later than 14 days after a corrective or mitigating measure is available"} |`,
    "",
    "All times are UTC. Deadlines are plain hour and day arithmetic from the timestamps you gave; whether",
    "any rule on how periods are counted applies to your case is for you or your counsel to confirm.",
    "",
    "## 1. Early warning",
    "",
    "Article 14(2)(a): without undue delay and in any event within 24 hours of becoming aware.",
    due(deadlines?.earlyWarningDue, "24 hours", "awareness + 24 hours"),
    "",
    "Pre-filled from local data:",
    "",
    ...productBlock(product),
    ...advisoryBlock(cveId, details),
    ...kevBlock(details),
    "",
    "To complete:",
    "",
    `- Member States where you know the product has been made available (where applicable): ${TODO("list the Member States")}`,
    `- Your contact point for this report: ${TODO("name, role and contact details; not taken from any local file")}`,
    "",
    "## 2. Vulnerability notification",
    "",
    "Article 14(2)(b): within 72 hours of becoming aware, unless the information was already provided.",
    due(deadlines?.notificationDue, "72 hours", "awareness + 72 hours"),
    "",
    "Pre-filled from local data:",
    "",
    "**General information about the product, as available**",
    "",
    ...productBlock(product),
    "",
    "**General nature of the exploit and the vulnerability**",
    "",
    ...advisoryBlock(cveId, details),
    ...kevBlock(details),
    `- What you know about the exploitation: ${TODO("how and where it was exploited; the CISA listing is a pointer, not your evidence")}`,
    "",
    "**Corrective or mitigating measures taken by the manufacturer** (from recorded runs and the policy file; what autoremediator knows about, not necessarily everything you did)",
    "",
    ...measuresBlock(findings),
    "",
    "To complete:",
    "",
    `- Corrective or mitigating measures users can take: ${TODO("for example the product version that contains the fix; the pre-filled measures above concern your dependencies, not your users' actions")}`,
    `- How sensitive you consider the information to be (where applicable): ${TODO("your assessment")}`,
    "",
    "## 3. Final report",
    "",
    "Article 14(2)(c): no later than 14 days after a corrective or mitigating measure is available, unless the information was already provided.",
    finalDue,
    "",
    "Pre-filled from local data:",
    "",
    "**Description of the vulnerability, including its severity and impact**",
    "",
    ...advisoryBlock(cveId, details),
    `- Impact on your product: ${TODO("what an attacker could do against your product and your users")}`,
    "",
    "**Information on any malicious actor exploiting the vulnerability, where available**",
    "",
    ...(details?.kev?.knownRansomwareCampaignUse
      ? [`- CISA's ransomware-use field: ${details.kev.knownRansomwareCampaignUse}`]
      : []),
    `- ${TODO("what you know about who is exploiting it; leave empty if nothing is known")}`,
    "",
    "**Details of the security update or other corrective measures made available**",
    "",
    ...measuresBlock(findings),
    `- Release that ships the fix to your users: ${TODO("version and date")}`,
    "",
    "## Afterwards",
    "",
    "- Article 14(8): inform the impacted users, and where appropriate all users, about the vulnerability and the measures they can take, where appropriate in a structured, machine-readable format. `vex/vex.cdx.json` and `vex/vex.openvex.json` in this pack are machine-readable statements about your dependencies; whether they suit your users is your decision.",
    "- Article 14(6): the CSIRT may ask for an intermediate report.",
    "",
    "## Sources",
    "",
    "- Regulation (EU) 2024/2847 (Cyber Resilience Act), Official Journal L, 20.11.2024; Article 14 paragraphs 1, 2, 6, 7 and 8, Article 3(42), Article 16.",
    "- The field lists above follow the text of Article 14(2) as read on springlex.eu and cross-checked against secondary commentary; confirm them against the Official Journal text and against the fields the reporting platform actually shows.",
    "",
  ];

  return {
    cveId,
    fileName: `${safeFileStem(cveId)}.md`,
    markdown: lines.join("\n"),
    ...(deadlines ? { deadlines } : {}),
    status,
  };
}
