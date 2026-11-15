import { z } from "zod";

import {
  OPTION_DESCRIPTIONS,
  PACKAGE_MANAGER_VALUES,
  pathField,
  registryPackageName,
} from "../platform/option-schemas.js";
import { defineOperation, type Operation } from "./define-operation.js";

const response = (description: string, properties: Record<string, unknown>) => ({
  description,
  schema: { type: "object", properties },
});

const readMaintainerVexInput = z
  .object({
    cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
    advisory: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Only statements that name this advisory (a CVE or GHSA id, or an alias of it)."),
    packageName: registryPackageName()
      .optional()
      .describe("Only the document shipped by this installed package."),
  })
  .strict();

const maintainInput = z
  .object({
    cwd: pathField("Directory of the package being developed (default: process.cwd())").optional(),
    advisories: z
      .array(z.string().min(1).max(100))
      .max(200)
      .optional()
      .describe(
        "CVE or GHSA ids to assess. Default: the package manager's audit of this project (network).",
      ),
    assertNotAffected: z
      .boolean()
      .optional()
      .describe(
        "Vouch for the static reachability result: advisories whose vulnerable dependency no source file reaches are written as not_affected (vulnerable_code_not_in_execute_path). Without it they are written as under_investigation.",
      ),
    traceFile: pathField(
      "A runtime trace from `trace run`; adds evidence and can only make a verdict more cautious.",
    ).optional(),
    policy: pathField(OPTION_DESCRIPTIONS.policy).optional(),
    packageManager: z.enum(PACKAGE_MANAGER_VALUES).optional().describe(OPTION_DESCRIPTIONS.packageManager),
    offlineIntelligence: z.boolean().optional().describe(OPTION_DESCRIPTIONS.offlineIntelligence),
    intelligenceSnapshotPath: pathField(OPTION_DESCRIPTIONS.intelligenceSnapshotPath).optional(),
    nextVersion: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "The exact version the next release will have; the VEX document must name it. Default: current version plus the highest pending changeset bump (at least a patch).",
      ),
    yes: z.boolean().optional().describe("Write the changes. Without it, only report them."),
  })
  .strict();

export const MAINTAINER_VEX_OPERATIONS: readonly Operation[] = [
  defineOperation({
    name: "readMaintainerVex",
    title: "Read VEX documents shipped by installed packages",
    description:
      "List the OpenVEX documents that installed packages ship in their tarball (package.json#vex, default vex.openvex.json) as validated data: who vouches for what, with which justification. Documents are untrusted input: size-capped, strictly validated against OpenVEX v0.2.0, and used only when their products name the exact installed package@version. Invalid documents are listed with the reason. Also reports what this project's own package.json#vex declares. Reads node_modules only; no network.",
    input: readMaintainerVexInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    response: response("MaintainerVexReport", {
      schemaVersion: { type: "string" },
      cwd: { type: "string" },
      scanned: { type: "number" },
      packages: { type: "array", items: { type: "object" } },
      rejected: { type: "array", items: { type: "object" } },
      own: { type: "object" },
      notes: { type: "array", items: { type: "string" } },
    }),
    mcp: true,
    http: { method: "POST", path: "/maintainer-vex", positional: [] },
    handler: (options, context) => context.api.readMaintainerVexFn(options),
  }),
  defineOperation({
    name: "maintain",
    title: "Maintainer autopilot",
    description:
      "For package authors: when a dependency of the package being developed has an advisory, decide whether the package is affected (static reachability from its source, plus a runtime trace when given) and prepare, never publish or push: a bump plan, a changeset when the repository uses changesets, and an OpenVEX statement shipped in the package (package.json#vex and files). not_affected is only written when the static scan finds the dependency unreachable and assertNotAffected is set. Reports a diff and writes nothing unless yes is set. Command line and SDK only.",
    input: maintainInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    response: response("MaintainResult", {
      schemaVersion: { type: "string" },
      cwd: { type: "string" },
      package: { type: "object" },
      nextVersion: { type: "string" },
      usesChangesets: { type: "boolean" },
      advisories: { type: "array", items: { type: "object" } },
      changes: { type: "array", items: { type: "object" } },
      drift: { type: "boolean" },
      applied: { type: "boolean" },
      conflicts: { type: "array", items: { type: "string" } },
      notes: { type: "array", items: { type: "string" } },
    }),
    mcp: false,
    handler: (options, context) =>
      context.api.maintainFn({
        ...options,
        source: context.source,
      }),
  }),
];
