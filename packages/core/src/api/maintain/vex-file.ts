import { randomUUID } from "node:crypto";

import {
  OPENVEX_CONTEXT,
  npmPurl,
  parseOpenVex,
  type OpenVexDocument,
  type OpenVexStatement,
} from "../../platform/maintainer-vex/index.js";

/** What `maintain` decided to say about one advisory. */
export interface DraftStatement {
  advisory: string;
  status: "not_affected" | "affected" | "under_investigation";
  /** The vulnerable dependencies (production) the statement is about. */
  subcomponents: string[];
  statusNotes: string;
  actionStatement?: string;
}

export interface VexFileInput {
  existing: string | undefined;
  packageName: string;
  /** The version the next release will have. */
  version: string;
  author: string;
  tooling: string;
  statements: DraftStatement[];
  now: Date;
}

export type VexFileResult = { content: string; kept: number } | { conflict: string };

const productPurl = (name: string, version: string): string => npmPurl(name, version);

function buildStatement(draft: DraftStatement, input: VexFileInput): OpenVexStatement {
  const purl = productPurl(input.packageName, input.version);
  return {
    "@id": `urn:autoremediator:${input.packageName}@${input.version}:${draft.advisory.toLowerCase()}`,
    version: 1,
    vulnerability: { name: draft.advisory },
    timestamp: input.now.toISOString(),
    products: [
      {
        "@id": purl,
        identifiers: { purl },
        subcomponents: draft.subcomponents.toSorted().map((name) => ({
          "@id": npmPurl(name),
          identifiers: { purl: npmPurl(name) },
        })),
      },
    ],
    status: draft.status,
    status_notes: draft.statusNotes,
    ...(draft.status === "not_affected" ? { justification: "vulnerable_code_not_in_execute_path" as const } : {}),
    ...(draft.actionStatement ? { action_statement: draft.actionStatement } : {}),
    ...(draft.status === "affected" && draft.actionStatement
      ? { action_statement_timestamp: input.now.toISOString() }
      : {}),
  };
}

/** The part of a statement that says something, without the bookkeeping that changes on every write. */
function substance(statement: OpenVexStatement): string {
  const { timestamp: _t, version: _v, last_updated: _l, action_statement_timestamp: _a, ...rest } = statement;
  return JSON.stringify(rest);
}

function isOurs(statement: OpenVexStatement, purl: string, advisory: string): boolean {
  return (
    statement.vulnerability.name.toUpperCase() === advisory.toUpperCase() &&
    statement.products.length === 1 &&
    statement.products[0]!.identifiers?.purl === purl
  );
}

/**
 * Write or update the project's OpenVEX document for the next release. Statements for other
 * advisories, other versions and anything the author wrote by hand are kept as they are; a
 * statement for the same advisory and product is replaced only when what it says changed, so
 * running again with nothing new leaves the file byte for byte as it was.
 */
export function mergeVexFile(input: VexFileInput): VexFileResult {
  const purl = productPurl(input.packageName, input.version);
  let document: OpenVexDocument | undefined;
  if (input.existing !== undefined && input.existing.trim() !== "") {
    const parsed = parseOpenVex(input.existing);
    if ("error" in parsed) return { conflict: `${parsed.error}, so it was left alone` };
    document = parsed.document;
  }

  const statements = [...(document?.statements ?? [])];
  let changed = false;
  for (const draft of input.statements.toSorted((a, b) => a.advisory.localeCompare(b.advisory))) {
    const fresh = buildStatement(draft, input);
    const at = statements.findIndex((statement) => isOurs(statement, purl, draft.advisory));
    if (at === -1) {
      statements.push(fresh);
      changed = true;
      continue;
    }
    const current = statements[at]!;
    if (substance(current) === substance(fresh)) continue;
    statements[at] = { ...fresh, version: (current.version ?? 0) + 1 };
    changed = true;
  }

  if (document && !changed) {
    // Nothing to say that is not already said: keep the author's file exactly as written.
    return { content: input.existing!, kept: statements.length };
  }
  const next: OpenVexDocument = document
    ? {
        ...document,
        version: document.version + 1,
        last_updated: input.now.toISOString(),
        statements,
      }
    : {
        "@context": OPENVEX_CONTEXT,
        "@id": `urn:uuid:${randomUUID()}`,
        author: input.author,
        timestamp: input.now.toISOString(),
        version: 1,
        tooling: input.tooling,
        statements,
      };
  return { content: `${JSON.stringify(next, null, 2)}\n`, kept: statements.length };
}
