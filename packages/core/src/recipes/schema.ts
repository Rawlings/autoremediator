/**
 * The recipe format: what an agent learned when it made an upgrade work, as data.
 *
 * A recipe is never code and never trusted. It names a package and the version ranges the change
 * was observed across, says what broke, and carries the consumer-code change as context-anchored
 * hunks: exact lines before, the lines to remove, the lines to add, exact lines after. Applying one
 * means matching those lines exactly in the project's own source and turning the matches into an
 * ordinary unified diff, which then goes through the same validation as a diff an agent proposes.
 */
import { createHash } from "node:crypto";

import { validRange } from "semver";
import { z } from "zod";

export const RECIPE_SCHEMA_VERSION = 1;

/** A recipe file larger than this is refused unread. */
export const MAX_RECIPE_BYTES = 500_000;

/** npm package names: lower-case, no leading dot or underscore, optionally scoped. */
export const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** One line of source: no line breaks of any kind, no NUL, bounded length. */
const sourceLine = z
  .string()
  .max(2000)
  .refine((line) => !/[\n\r\0\u2028\u2029]/.test(line), "a line must not contain a line break or NUL");

const range = z
  .string()
  .max(100)
  .refine((value) => validRange(value) !== null, "must be a valid semver range");

const hunkSchema = z
  .object({
    /** Lines that must come immediately before the lines to remove (context, unchanged). */
    before: z.array(sourceLine).max(10).default([]),
    /** Lines replaced (may be empty for a pure insertion, which then needs context). */
    remove: z.array(sourceLine).max(200).default([]),
    /** Lines put in their place (may be empty for a pure deletion). */
    add: z.array(sourceLine).max(200).default([]),
    /** Lines that must come immediately after (context, unchanged). */
    after: z.array(sourceLine).max(10).default([]),
    /** A hunk that matches nowhere is fatal unless it is optional. */
    optional: z.boolean().optional(),
    note: z.string().max(300).optional(),
  })
  .strict()
  .refine(
    (hunk) => hunk.remove.length + hunk.add.length > 0 && hunk.remove.join("\n") !== hunk.add.join("\n"),
    "a hunk must change something",
  )
  .refine(
    (hunk) => [...hunk.before, ...hunk.remove, ...hunk.after].some((line) => line.trim().length > 0),
    "a hunk must be anchored by at least one non-blank line",
  );

const breakingSchema = z
  .object({
    /** e.g. `symbol-removed`, `import-changed`, `diagnostic-TS2554`, `test-failure`. */
    kind: z.string().max(60),
    symbol: z.string().max(200).optional(),
    message: z.string().max(500),
  })
  .strict();

const evidenceSchema = z
  .object({
    runId: z.string().max(100).optional(),
    attemptId: z.string().max(100).optional(),
    /** Who made the change: an agent id, or `recipe:<id>`. */
    agent: z.string().max(200).optional(),
    capturedAt: z.string().max(40).optional(),
    autoremediator: z.string().max(40).optional(),
    /** The verifier's checks on the repaired project, as they stood when it was accepted. */
    checks: z
      .array(z.object({ name: z.string().max(60), status: z.string().max(40) }).strict())
      .max(30)
      .default([]),
  })
  .strict();

export const recipeSchema = z
  .object({
    schemaVersion: z.literal(RECIPE_SCHEMA_VERSION),
    package: z.string().max(214).regex(NPM_PACKAGE_NAME, "must be an npm package name"),
    /** Versions the project is upgraded from. */
    fromRange: range,
    /** Versions the project is upgraded to. */
    toRange: range,
    /** The exact versions of the upgrade it was captured from, for naming and provenance. */
    observed: z
      .object({ fromVersion: z.string().max(100), toVersion: z.string().max(100) })
      .strict()
      .optional(),
    summary: z.string().max(500).optional(),
    breaking: z.array(breakingSchema).max(50).default([]),
    hunks: z.array(hunkSchema).min(1).max(100),
    evidence: evidenceSchema.optional(),
  })
  .strict();

export type Recipe = z.output<typeof recipeSchema>;
export type RecipeHunk = Recipe["hunks"][number];
export type RecipeBreaking = Recipe["breaking"][number];

/** Parse and validate recipe JSON. Throws one error naming every problem. */
export function parseRecipe(text: string): Recipe {
  if (Buffer.byteLength(text) > MAX_RECIPE_BYTES) throw new Error(`the recipe is larger than ${MAX_RECIPE_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error("the recipe is not valid JSON", { cause });
  }
  const parsed = recipeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `invalid recipe: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A stable id from what the recipe does (its package, ranges and hunks), not from who captured it:
 * the same change captured twice is the same recipe.
 */
export function recipeId(recipe: Recipe): string {
  const { evidence: _evidence, observed: _observed, summary: _summary, breaking: _breaking, ...essence } = recipe;
  return `${recipe.package}#${createHash("sha256").update(canonical(essence)).digest("hex").slice(0, 10)}`;
}

export function serializeRecipe(recipe: Recipe): string {
  return `${JSON.stringify(recipe, null, 2)}\n`;
}
