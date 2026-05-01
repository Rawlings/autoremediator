import { extname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { execa } from "execa";
import { parseNpmAuditJsonFile, type NormalizedFinding } from "./adapters/npm-audit.js";
import { parseNpmAuditJsonFromString } from "./adapters/npm-audit.js";
import { parseYarnAuditJsonFile } from "./adapters/yarn-audit.js";
import { parseYarnAuditJsonFromString } from "./adapters/yarn-audit.js";
import { parseSarifFile } from "./adapters/sarif.js";
import type { ScanInputFormat } from "./index.js";
import { detectPackageManager, resolveAuditCommand, type PackageManager } from "../platform/package-manager/index.js";

export function parseScanInput(filePath: string, format: ScanInputFormat): NormalizedFinding[] {
  // Reject null bytes to prevent path injection attacks
  if (filePath.includes("\0")) {
    throw new Error("Invalid scan input path: path contains null bytes");
  }
  const resolvedPath = resolve(filePath);
  const resolved = format === "auto" ? inferFormat(resolvedPath) : format;

  if (resolved === "npm-audit") {
    return parseNpmAuditJsonFile(resolvedPath);
  }
  if (resolved === "yarn-audit") {
    return parseYarnAuditJsonFile(resolvedPath);
  }
  if (resolved === "sarif") {
    return parseSarifFile(resolvedPath);
  }

  throw new Error(`Unsupported input format: ${resolved}`);
}

export async function parseScanInputFromAudit(params: {
  cwd: string;
  packageManager?: PackageManager;
  format: ScanInputFormat;
  workspace?: string;
}): Promise<NormalizedFinding[]> {
  const pm = params.packageManager ?? detectPackageManager(params.cwd);
  const resolved = params.format === "auto" ? defaultAuditFormat(pm) : params.format;

  ensureAuditFormatCompatibility(pm, resolved);

  if (resolved === "sarif") {
    throw new Error("SARIF format is not supported with --audit mode.");
  }

  const command = resolveAuditCommand(pm, { workspace: params.workspace });
  const [cmd, ...args] = command;

  const result = await execa(cmd, args, {
    cwd: params.cwd,
    stdio: "pipe",
    reject: false,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!output.trim()) {
    throw new Error(`No audit output received from ${command.join(" ")}.`);
  }

  try {
    const findings =
      resolved === "yarn-audit"
        ? parseYarnAuditJsonFromString(output)
        : parseNpmAuditJsonFromString(output);

    if ((result.exitCode ?? 0) !== 0 && findings.length === 0) {
      throw new Error("audit command returned non-zero exit without parseable findings");
    }

    return findings;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exit = (result.exitCode ?? 0) !== 0 ? ` (exit code ${result.exitCode})` : "";
    throw new Error(
      `Failed to parse output from ${command.join(" ")}${exit} as ${resolved}: ${message}`
    );
  }
}

function defaultAuditFormat(pm: PackageManager): Exclude<ScanInputFormat, "auto" | "sarif"> {
  if (pm === "yarn") return "yarn-audit";
  if (pm === "deno") {
    throw new Error(
      'Deno does not support a native audit command. Use --input with a SARIF or npm-audit scan file instead.'
    );
  }
  return "npm-audit";
}

function ensureAuditFormatCompatibility(
  pm: PackageManager,
  resolved: Exclude<ScanInputFormat, "auto">
): void {
  if (resolved === "sarif") return;

  if (pm === "deno") {
    throw new Error(
      'Deno does not support a native audit command. Use --input with a SARIF or npm-audit scan file instead.'
    );
  }

  if (pm === "yarn" && resolved !== "yarn-audit") {
    throw new Error('Format "npm-audit" is not supported with package manager "yarn" in --audit mode. Use --format yarn-audit or --format auto.');
  }

  if (pm !== "yarn" && resolved !== "npm-audit") {
    throw new Error(`Format "${resolved}" is not supported with package manager "${pm}" in --audit mode. Use --format npm-audit or --format auto.`);
  }
}

function inferFormat(filePath: string): Exclude<ScanInputFormat, "auto"> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".sarif") return "sarif";

  try {
    const content = readFileSync(filePath, "utf8");
    const firstLine = content.split("\n").find((line) => line.trim().startsWith("{"));
    if (firstLine) {
      const parsed = JSON.parse(firstLine) as { type?: string };
      if (parsed.type === "auditAdvisory" || parsed.type === "auditSummary") {
        return "yarn-audit";
      }
    }
  } catch {
    // Ignore parse failures and fall back to npm-audit.
  }

  return "npm-audit";
}
