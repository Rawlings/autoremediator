import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import semver from "semver";
import { z } from "zod";

import table from "./replaceable.json" with { type: "json" };
import type {
  DependencySection,
  NodeRequirement,
  ReplaceableDependency,
  ReplaceableStatus,
} from "./types.js";

const rowSchema = z
  .object({
    package: z.string().min(1),
    replacement: z.string().min(1),
    nodeRange: z
      .string()
      .refine((range) => semver.validRange(range) !== null, "nodeRange must be a semver range"),
    migration: z.string().min(1),
    fit: z.enum(["drop-in", "check-usage"]),
    caveat: z.string().optional(),
    coveredSymbols: z.array(z.string().min(1)).optional(),
    example: z.object({ after: z.string().min(1), result: z.string() }).strict(),
    source: z.url(),
  })
  .strict();

const tableSchema = z
  .object({ version: z.literal(1), about: z.string(), replacements: z.array(rowSchema).min(1) })
  .strict();

export type ReplacementRow = z.infer<typeof rowSchema>;

/** The curated table, validated once: a malformed row is a build-time mistake and fails loudly. */
export const REPLACEMENTS: readonly ReplacementRow[] = tableSchema.parse(table).replacements;

const BY_PACKAGE = new Map(REPLACEMENTS.map((row) => [row.package, row]));

export function replacementFor(packageName: string): ReplacementRow | undefined {
  return BY_PACKAGE.get(packageName);
}

/** Node floor from `engines.node`, else `.nvmrc` / `.node-version`; undefined when none is declared. */
export function readNodeRequirement(
  /** The package itself first, then its workspace root: the first to declare a floor wins. */
  candidates: readonly { dir: string; manifest: { engines?: unknown } }[],
  root: string,
): NodeRequirement | undefined {
  for (const { dir, manifest } of candidates) {
    const engines = manifest.engines;
    if (engines && typeof engines === "object") {
      const range = (engines as { node?: unknown }).node;
      if (typeof range === "string" && semver.validRange(range) !== null) {
        return { range, source: "engines.node", file: relative(root, join(dir, "package.json")) };
      }
    }
    for (const name of [".nvmrc", ".node-version"] as const) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      const pinned = readFileSync(file, "utf8").split("\n")[0]?.trim().replace(/^v/, "") ?? "";
      // `lts/*`, `node` and other aliases do not name a version, so no floor can be claimed.
      if (!/^\d+(\.\d+){0,2}$/.test(pinned)) continue;
      const floor = semver.coerce(pinned)?.version;
      if (floor) return { range: `>=${floor}`, source: name, file: relative(root, file) };
    }
  }
  return undefined;
}

/** Does every Node version the project declares have the API? */
export function nodeHas(requirement: NodeRequirement, availableRange: string): boolean {
  try {
    return semver.subset(requirement.range, availableRange);
  } catch {
    return false;
  }
}

/**
 * Judge each declared dependency against the table. `symbolsUsed` is what the source imports from
 * the package (`*` when it cannot be told); rows with `coveredSymbols` only apply when every
 * imported symbol is one the replacement covers.
 */
export function findReplaceable(
  declared: readonly { name: string; section: DependencySection; range: string }[],
  requirement: NodeRequirement | undefined,
  symbolsUsed: (name: string) => ReadonlySet<string> | undefined,
): ReplaceableDependency[] {
  const found: ReplaceableDependency[] = [];
  for (const dependency of declared) {
    const row = BY_PACKAGE.get(dependency.name);
    if (!row) continue;

    let status: ReplaceableStatus;
    let reason: string;
    const used = symbolsUsed(dependency.name);
    const uncovered = row.coveredSymbols
      ? [...(used ?? [])].filter((symbol) => !row.coveredSymbols!.includes(symbol))
      : [];

    if (uncovered.length > 0) {
      status = "not-covered";
      reason = `the source imports ${uncovered.map((symbol) => (symbol === "*" ? "the whole module" : symbol)).join(", ")}, but ${row.replacement} replaces only ${row.coveredSymbols!.join(", ")}`;
    } else if (!requirement) {
      status = "unknown-node";
      reason = `${row.replacement} needs Node ${row.nodeRange}, and the project declares no minimum (set engines.node)`;
    } else if (nodeHas(requirement, row.nodeRange)) {
      status = "replaceable";
      reason = `the project declares Node ${requirement.range} (${requirement.source}); ${row.replacement} is in Node ${row.nodeRange}`;
    } else {
      status = "blocked-by-node";
      reason = `the project declares Node ${requirement.range} (${requirement.source}), which includes versions without ${row.replacement} (Node ${row.nodeRange})`;
    }

    found.push({
      name: dependency.name,
      section: dependency.section,
      range: dependency.range,
      status,
      replacement: row.replacement,
      nodeRange: row.nodeRange,
      migration: row.migration,
      fit: row.fit,
      ...(row.caveat ? { caveat: row.caveat } : {}),
      reason,
      source: row.source,
    });
  }
  return found;
}
