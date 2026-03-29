import type { ScanReport } from "./contracts.js";

type SarifLevel = "error" | "warning" | "note" | "none";

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
  helpUri: string;
  properties: { severity: string };
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string; uriBaseId: string };
    };
  }>;
}

export interface SarifOutput {
  version: "2.1.0";
  $schema: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        informationUri: string;
        rules: SarifRule[];
      };
    };
    results: SarifResult[];
  }>;
}

function severityToSarifLevel(severity: string): SarifLevel {
  if (severity === "CRITICAL" || severity === "HIGH") return "error";
  if (severity === "MEDIUM") return "warning";
  if (severity === "LOW") return "note";
  return "warning";
}

export function toSarifOutput(report: ScanReport): SarifOutput {
  const rules: SarifRule[] = [];
  const results: SarifResult[] = [];
  const seenRules = new Set<string>();

  for (const cveReport of report.reports) {
    const severity = cveReport.cveDetails?.severity ?? "UNKNOWN";
    const level = severityToSarifLevel(severity);
    const summary = cveReport.cveDetails?.summary ?? cveReport.cveId;

    if (!seenRules.has(cveReport.cveId)) {
      seenRules.add(cveReport.cveId);
      rules.push({
        id: cveReport.cveId,
        name: "VulnerableDependency",
        shortDescription: { text: cveReport.cveId },
        fullDescription: { text: summary },
        defaultConfiguration: { level },
        helpUri: `https://osv.dev/vulnerability/${cveReport.cveId}`,
        properties: { severity },
      });
    }

    for (const vulnerablePackage of cveReport.vulnerablePackages) {
      const fixText = vulnerablePackage.affected.firstPatchedVersion
        ? ` Fix: upgrade to ${vulnerablePackage.affected.firstPatchedVersion}.`
        : " No fixed version available.";
      results.push({
        ruleId: cveReport.cveId,
        level,
        message: {
          text: `${vulnerablePackage.installed.name}@${vulnerablePackage.installed.version} is vulnerable to ${cveReport.cveId}: ${summary}${fixText}`,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "package.json", uriBaseId: "%SRCROOT%" },
            },
          },
        ],
      });
    }
  }

  return {
    version: "2.1.0",
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Documents/CommitteeSpecifications/2.1.0/sarif-schema-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "autoremediator",
            informationUri: "https://github.com/Rawlings/autoremediator",
            rules,
          },
        },
        results,
      },
    ],
  };
}
