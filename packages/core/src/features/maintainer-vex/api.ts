import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  parseOpenVex,
  readInstalledMaintainerVex,
  readVexFile,
  resolveVexField,
  statementsFor,
  type OpenVexStatement,
  type VexRejection,
} from "./index.js";

export interface ReadMaintainerVexOptions {
  /** Project directory whose `node_modules` is read. Default: the current directory. */
  cwd?: string;
  /** Only statements that name this advisory (CVE or GHSA id, or an alias). */
  advisory?: string;
  /** Only documents shipped by this package. */
  packageName?: string;
}

export interface MaintainerVexStatementSummary {
  vulnerability: string;
  aliases: string[];
  status: OpenVexStatement["status"];
  justification?: string;
  impactStatement?: string;
  statusNotes?: string;
  actionStatement?: string;
  /** Packages the statement is about besides the shipping package itself; empty when it is about the package. */
  subcomponents: string[];
  timestamp: string;
}

export interface ShippedVexSummary {
  name: string;
  version: string;
  file: string;
  documentId: string;
  author: string;
  timestamp: string;
  statements: MaintainerVexStatementSummary[];
}

/** What this project's own `package.json#vex` says, so an author can check what will ship. */
export interface OwnVexSummary {
  declared: boolean;
  file?: string;
  status?: "valid" | "invalid";
  /** Why it is invalid, or a remark on a valid one. */
  reason?: string;
  statements?: number;
}

export interface MaintainerVexReport {
  schemaVersion: "1.0";
  cwd: string;
  /** Installed packages looked at. */
  scanned: number;
  packages: ShippedVexSummary[];
  /** Declared documents that were not used, with the reason. Never fatal. */
  rejected: VexRejection[];
  own: OwnVexSummary;
  notes: string[];
}

function summarize(
  statement: OpenVexStatement,
  subcomponents: Array<{ name: string; version?: string }> | undefined,
  documentTimestamp: string,
): MaintainerVexStatementSummary {
  return {
    vulnerability: statement.vulnerability.name,
    aliases: statement.vulnerability.aliases ?? [],
    status: statement.status,
    ...(statement.justification ? { justification: statement.justification } : {}),
    ...(statement.impact_statement ? { impactStatement: statement.impact_statement } : {}),
    ...(statement.status_notes ? { statusNotes: statement.status_notes } : {}),
    ...(statement.action_statement ? { actionStatement: statement.action_statement } : {}),
    subcomponents: (subcomponents ?? []).map((sub) =>
      sub.version ? `${sub.name}@${sub.version}` : sub.name,
    ),
    timestamp: statement.timestamp ?? documentTimestamp,
  };
}

function readOwn(cwd: string): OwnVexSummary {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return { declared: false };
  }
  if (!Object.hasOwn(manifest, "vex")) return { declared: false };
  const field = resolveVexField(manifest["vex"]);
  if ("error" in field) return { declared: true, status: "invalid", reason: field.error };
  const file = readVexFile(cwd, field.path);
  if ("error" in file) {
    return {
      declared: true,
      file: field.path,
      status: "invalid",
      reason: `${field.path} ${file.error}`,
    };
  }
  const parsed = parseOpenVex(file.content);
  if ("error" in parsed) {
    return {
      declared: true,
      file: field.path,
      status: "invalid",
      reason: `${field.path} ${parsed.error}`,
    };
  }
  const name = manifest["name"];
  const version = manifest["version"];
  const about =
    typeof name === "string" && typeof version === "string"
      ? statementsFor(parsed.document, { name, version }).length
      : 0;
  return {
    declared: true,
    file: field.path,
    status: "valid",
    statements: parsed.document.statements.length,
    reason:
      about === 0
        ? `none of its statements is about ${String(name)}@${String(version)}, the version in package.json; consumers only use statements about the version they install, so it must carry the version being released`
        : undefined,
  };
}

/**
 * Read the VEX documents that installed packages ship (`package.json#vex` in `node_modules`), as
 * validated data. Everything read is untrusted: invalid documents and declarations are listed under
 * `rejected` and nothing in a document is ever executed or followed.
 */
export function readMaintainerVex(options: ReadMaintainerVexOptions = {}): MaintainerVexReport {
  const cwd = resolve(options.cwd ?? process.cwd());
  const index = readInstalledMaintainerVex(cwd);
  const wanted = options.advisory?.toUpperCase();

  const packages: ShippedVexSummary[] = [];
  for (const shipped of index.documents) {
    if (options.packageName && shipped.package.name !== options.packageName) continue;
    const statements = shipped.statements
      .filter(({ statement }) => {
        if (!wanted) return true;
        return [statement.vulnerability.name, ...(statement.vulnerability.aliases ?? [])].some(
          (id) => id.toUpperCase() === wanted,
        );
      })
      .map(({ statement, subcomponents }) =>
        summarize(statement, subcomponents, shipped.document.timestamp),
      );
    if (statements.length === 0) continue;
    packages.push({
      name: shipped.package.name,
      version: shipped.package.version,
      file: shipped.file,
      documentId: shipped.document["@id"],
      author: shipped.document.author,
      timestamp: shipped.document.timestamp,
      statements,
    });
  }

  return {
    schemaVersion: "1.0",
    cwd,
    scanned: index.scanned,
    packages: packages.toSorted((a, b) =>
      `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
    ),
    rejected: index.rejected
      .filter((entry) => !options.packageName || entry.package === options.packageName)
      .toSorted((a, b) => a.package.localeCompare(b.package)),
    own: readOwn(cwd),
    notes: index.notes,
  };
}
