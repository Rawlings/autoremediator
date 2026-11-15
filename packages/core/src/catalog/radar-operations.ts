import { z } from "zod";

import { OPTION_DESCRIPTIONS, pathField } from "../platform/option-schemas.js";
import { defineOperation, type Operation } from "./define-operation.js";

const radarInput = z
  .object({
    cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
    includeTransitive: z
      .boolean()
      .optional()
      .describe("Also look at transitive dependencies (default: direct dependencies only)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Most entries returned, best first (default 20)."),
    maxPackages: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        "Most packages analysed, direct dependencies first (default 100). Bounds network use.",
      ),
    target: z
      .enum(["latest", "minor", "patch"])
      .optional()
      .describe(
        "Which release to compare the installed one with: the latest (default), the newest in the same major, or the newest in the same minor.",
      ),
    github: z
      .boolean()
      .optional()
      .describe(
        "Also read GitHub release notes for releases that have no changelog in the package (unauthenticated GitHub API, stops at the rate limit). Default: package contents only.",
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Language model "<provider>:<model-id>" that adds a bounded classification of the change (it can only add points). Off by default; package text is sent to the provider when set.',
      ),
    offline: z.boolean().optional().describe("Refused: radar needs the npm registry."),
    assess: z
      .boolean()
      .optional()
      .describe(
        "Rate the upgrade impact on this project for the best flagged direct dependencies (default true).",
      ),
  })
  .strict();

export const RADAR_OPERATIONS: readonly Operation[] = [
  defineOperation({
    name: "radar",
    title: "Silent-fix radar",
    description:
      "Find security-relevant changes that have no published advisory. For each direct (optionally transitive) dependency, compares the installed version with the latest (or the newest minor or patch) and flags releases in between that look like security fixes: changelog text with a fixed security vocabulary (negation understood), code differences between the published tarballs (added guards, containment checks, length limits, sanitizers; ReDoS-prone regular expressions removed; dangerous sinks removed), and registry metadata (a predecessor deprecated for security). Returns a ranked list with a transparent score, a confidence label (likely, possible, weak), the upgrade distance, quoted evidence for every flag, an OSV cross-check (an entry is marked now-advisory with the id when one exists) and, for direct dependencies, the upgrade impact on this project. Never states that a vulnerability exists: it reports a security-relevant change without a published advisory. Heuristic; evidence is untrusted text from packages. Downloads package metadata and tarballs within a byte and time budget; changes nothing.",
    input: radarInput,
    // Changes nothing, but can spend model tokens, call GitHub and download up to a 256 MB tarball budget: not a reader's call.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    response: {
      description: "RadarReport",
      schema: {
        type: "object",
        properties: {
          schemaVersion: { type: "string" },
          disclaimer: { type: "string" },
          target: { type: "string", enum: ["latest", "minor", "patch"] },
          analysed: { type: "integer" },
          upToDate: { type: "integer" },
          clean: { type: "integer" },
          flagged: { type: "integer" },
          entries: { type: "array", items: { type: "object" } },
          skipped: { type: "array", items: { type: "object" } },
          notes: { type: "array", items: { type: "string" } },
          bytesDownloaded: { type: "integer" },
          scoring: { type: "object" },
        },
      },
    },
    mcp: true,
    http: { method: "POST", path: "/radar", positional: [] },
    handler: (options, context) => context.api.radarFn({ ...options, source: context.source }),
  }),
];
