import { z } from "zod";

/**
 * OpenVEX v0.2.0 (https://github.com/openvex/spec/blob/main/OPENVEX-SPEC.md), as far as consuming
 * and writing it needs. Validation is strict on purpose: documents shipped inside installed
 * packages are untrusted input, so an unknown key, a wrong type or a bad enum value rejects the
 * whole document instead of being guessed at.
 */
export const OPENVEX_CONTEXT = "https://openvex.dev/ns/v0.2.0";

export const OPENVEX_STATUSES = ["not_affected", "affected", "fixed", "under_investigation"] as const;
export type OpenVexStatus = (typeof OPENVEX_STATUSES)[number];

export const OPENVEX_JUSTIFICATIONS = [
  "component_not_present",
  "vulnerable_code_not_present",
  "vulnerable_code_not_in_execute_path",
  "vulnerable_code_cannot_be_controlled_by_adversary",
  "inline_mitigations_already_exist",
] as const;
export type OpenVexJustification = (typeof OPENVEX_JUSTIFICATIONS)[number];

/** Limits that bound what a hostile document can cost. */
export const MAX_VEX_BYTES = 1024 * 1024;
export const MAX_VEX_DEPTH = 12;
export const MAX_STATEMENTS = 2000;
const MAX_LIST = 200;

const text = (max: number) => z.string().min(1).max(max);
const longText = z.string().max(8000);
const iri = text(2048);
const timestamp = z.iso.datetime({ offset: true });

const identifiers = z
  .object({
    purl: text(512).optional(),
    cpe22: text(1024).optional(),
    cpe23: text(1024).optional(),
  })
  .strict();

const hashes = z.record(text(64), text(256)).refine((value) => Object.keys(value).length <= 20, {
  message: "at most 20 hashes",
});

const component = z
  .object({
    "@id": iri.optional(),
    identifiers: identifiers.optional(),
    hashes: hashes.optional(),
  })
  .strict();

const product = z
  .object({
    "@id": iri.optional(),
    identifiers: identifiers.optional(),
    hashes: hashes.optional(),
    subcomponents: z.array(component).max(MAX_LIST).optional(),
  })
  .strict();

const vulnerability = z
  .object({
    "@id": iri.optional(),
    name: text(256),
    description: longText.optional(),
    aliases: z.array(text(256)).max(MAX_LIST).optional(),
  })
  .strict();

const statement = z
  .object({
    "@id": iri.optional(),
    version: z.number().int().min(0).optional(),
    vulnerability,
    timestamp: timestamp.optional(),
    last_updated: timestamp.optional(),
    products: z.array(product).min(1).max(MAX_LIST),
    status: z.enum(OPENVEX_STATUSES),
    supplier: text(512).optional(),
    status_notes: longText.optional(),
    justification: z.enum(OPENVEX_JUSTIFICATIONS).optional(),
    impact_statement: longText.optional(),
    action_statement: longText.optional(),
    action_statement_timestamp: timestamp.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== "not_affected" ||
      value.justification !== undefined ||
      (value.impact_statement !== undefined && value.impact_statement.trim() !== ""),
    { message: "a not_affected statement needs a justification or an impact_statement" },
  );

export const openVexDocumentSchema = z
  .object({
    "@context": z.literal(OPENVEX_CONTEXT),
    "@id": iri,
    author: text(512),
    role: text(512).optional(),
    timestamp,
    last_updated: timestamp.optional(),
    version: z.number().int().min(1),
    tooling: text(512).optional(),
    statements: z.array(statement).max(MAX_STATEMENTS),
  })
  .strict();

export type OpenVexDocument = z.infer<typeof openVexDocumentSchema>;
export type OpenVexStatement = OpenVexDocument["statements"][number];
export type OpenVexProduct = OpenVexStatement["products"][number];

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Reject structure a legitimate VEX document never has: object keys that are used to attack
 * prototypes, and nesting deeper than the format can need. Iterative so a deeply nested file cannot
 * overflow the stack.
 */
export function findHostileStructure(value: unknown): string | undefined {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (typeof node !== "object" || node === null) continue;
    visited += 1;
    if (visited > 200_000) return "has too many nested values";
    if (depth > MAX_VEX_DEPTH) return `is nested deeper than ${MAX_VEX_DEPTH} levels`;
    if (Array.isArray(node)) {
      for (const child of node as unknown[]) stack.push({ node: child, depth: depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(key)) return `has a "${key}" key`;
      stack.push({ node: child, depth: depth + 1 });
    }
  }
  return undefined;
}

export type ParsedOpenVex = { document: OpenVexDocument } | { error: string };

/** Parse and validate document text. Never throws. */
export function parseOpenVex(content: string): ParsedOpenVex {
  if (Buffer.byteLength(content, "utf8") > MAX_VEX_BYTES) {
    return { error: `is larger than ${MAX_VEX_BYTES / 1024} KiB` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { error: "is not valid JSON" };
  }
  const hostile = findHostileStructure(raw);
  if (hostile) return { error: hostile };
  const parsed = openVexDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    const reason =
      issue?.code === "unrecognized_keys"
        ? `unknown field(s) ${issue.keys.map((key) => `"${key}"`).join(", ")}`
        : (issue?.message ?? "does not match the schema");
    return { error: `is not an OpenVEX v0.2.0 document: ${where}: ${reason}` };
  }
  return { document: parsed.data };
}
