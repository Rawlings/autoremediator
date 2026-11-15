import { z } from "zod";

import {
  OPTION_DESCRIPTIONS,
  PACKAGE_MANAGER_VALUES,
  packageNameSchema,
  pathField,
} from "../platform/option-schemas.js";
import { defineOperation, type Operation } from "./define-operation.js";

const response = (description: string, properties: Record<string, unknown>) => ({
  description,
  schema: { type: "object", properties },
});

const freshnessInput = {
  cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
  policy: pathField(OPTION_DESCRIPTIONS.policy).optional(),
  packageManager: z.enum(PACKAGE_MANAGER_VALUES).optional().describe(OPTION_DESCRIPTIONS.packageManager),
  packages: z
    .array(packageNameSchema)
    .max(200)
    .optional()
    .describe("Only these direct dependencies. Default: all of them."),
  allowHigh: z
    .boolean()
    .optional()
    .describe(
      "Take steps assessUpgrade rates High. They are held otherwise, and a held step is reported, never planned.",
    ),
};

export const FRESHNESS_OPERATIONS: readonly Operation[] = [
  defineOperation({
    name: "freshnessReport",
    title: "Dependency freshness report",
    description:
      "How far behind the latest release each direct dependency is (major, minor and patch distance, stable releases behind, age of the installed version from the registry's publish times), a 0-100 project freshness score, and, for dependencies past the policy's `freshness` limits (maxMajorsBehind, maxMinorsBehind, maxAgeDays, ignore), the climb back: one package, one jump at a time, the catch-up to the newest release on the installed major first and then one major per step. With assess, the first step of each climb is rated with assessUpgrade and the climbs are ordered safest first; High ones are held. Needs the dependencies installed. Changes nothing.",
    input: z
      .object({
        ...freshnessInput,
        assess: z
          .boolean()
          .optional()
          .describe(
            "Rate the first step of each climb with assessUpgrade (downloads two tarballs per package). Default false.",
          ),
      })
      .strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    response: response("FreshnessReport", {
      schemaVersion: { type: "string" },
      score: { type: "number" },
      policy: { type: "object", nullable: true },
      counts: { type: "object" },
      packages: { type: "array", items: { type: "object" } },
      climbs: { type: "array", items: { type: "object" } },
      unplanned: { type: "array", items: { type: "object" } },
      notes: { type: "array", items: { type: "string" } },
    }),
    mcp: true,
    http: { method: "POST", path: "/freshness", positional: [] },
    handler: (options, context) => context.api.freshnessReportFn(options),
  }),
  defineOperation({
    name: "planFreshnessStep",
    title: "Plan the next freshness step",
    description:
      "Record the next dependency freshness step as a plan, to be carried out with applyPlan after review: the first step of the safest climb that is not held (every step is rated with assessUpgrade; High ones are held unless allowHigh, major bumps need allowMajorBumps in the policy). One package, one jump. Only one plan is recorded, because applying it changes the manifests any other plan was made against; call this again after applyPlan for the next one. Apply it with applyPlan, verify with verifyRun, undo with rollbackRun: every step is its own run. At autonomy L0 no plan is recorded. Changes nothing in the project.",
    input: z
      .object({
        ...freshnessInput,
        assess: z
          .boolean()
          .optional()
          .describe("Rate steps with assessUpgrade (default true); false orders by step size only."),
        runTests: z.boolean().optional().describe(OPTION_DESCRIPTIONS.runTests),
        typecheck: z
          .boolean()
          .optional()
          .describe(OPTION_DESCRIPTIONS.typecheck),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    response: response("FreshnessPlanResult", {
      planned: { type: "object" },
      reason: { type: "string" },
      held: { type: "array", items: { type: "object" } },
      report: { type: "object" },
    }),
    mcp: true,
    http: { method: "POST", path: "/freshness/plan", positional: [] },
    handler: (options, context) =>
      context.api.planFreshnessStepFn({ ...options, source: context.source }),
  }),
];
