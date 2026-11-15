import { z } from "zod";

import { OPTION_DESCRIPTIONS, pathField } from "../../infra/policy/schemas.js";
import { defineOperation, type Operation } from "./define-operation.js";

/**
 * Analysis that reads the project and git history. Neither operation changes the project: `plan`
 * records a plan (never applied) and `outputDir` writes report files, both only when asked for.
 */
const ANALYSIS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const outputDir = (what: string) =>
  pathField(
    `Directory to write ${what} into (created if needed). Nothing is written without it.`,
  ).optional();

const incidentInput = z
  .object({
    target: z
      .string("target is required (string)")
      .min(1, "target is required (string)")
      .max(300)
      .describe(
        'What was compromised: an advisory id (MAL-…, GHSA-…, CVE-…), or package@range such as lodash@4.17.21 or "left-pad@>=1.3.0 <1.3.2". package@range needs no lookup.',
      ),
    cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
    plan: z
      .boolean()
      .optional()
      .describe(
        "Record the rollback to the last safe version as a plan that applyPlan can carry out after review. Never applied by this call.",
      ),
    offline: z
      .boolean()
      .optional()
      .describe(
        "No network: no advisory lookup and no registry. An id then needs intelligenceSnapshotPath.",
      ),
    intelligenceSnapshotPath: pathField(OPTION_DESCRIPTIONS.intelligenceSnapshotPath).optional(),
    policy: pathField(OPTION_DESCRIPTIONS.policy).optional(),
    history: z
      .boolean()
      .optional()
      .describe("Read git history for when the versions came and went. Default true."),
    maxCommits: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe("Most lockfile commits to read from history, newest first. Default 500."),
    outputDir: outputDir("incident-report.md and incident-report.json"),
  })
  .strict();

const premortemTarget = z
  .object({
    cwd: pathField(OPTION_DESCRIPTIONS.cwd),
    label: z.string().max(100).optional().describe("Display name for this repository"),
  })
  .strict();

const premortemInput = z
  .object({
    targets: z
      .array(premortemTarget)
      .optional()
      .describe(
        "Repository checkouts to read, as in the portfolio targets file (only cwd and label are used).",
      ),
    root: pathField(
      "Find the repositories (a .git next to a package.json) under this directory instead of listing them.",
    ).optional(),
    packages: z
      .array(z.string().min(1).max(214))
      .max(100)
      .optional()
      .describe(
        "Packages to assess. Default: the most depended-upon ones across the repositories.",
      ),
    top: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("With no packages: how many to pick. Default 10."),
    rankBy: z
      .enum(["depended-upon", "privileged"])
      .optional()
      .describe(
        "How to pick them: most depended-upon (default), or most privileged (packages that run install scripts first).",
      ),
    playbooks: z
      .enum(["repo", "package"])
      .optional()
      .describe("One playbook per repository (default) or per package."),
    outputDir: outputDir("premortem.md, premortem.json and the playbooks (commit them)"),
  })
  .strict();

const response = (description: string, properties: Record<string, unknown>) => ({
  description,
  schema: { type: "object", properties },
});

export const INCIDENT_OPERATIONS: readonly Operation[] = [
  defineOperation({
    name: "incident",
    title: "Respond to a compromised package",
    description:
      "Supply-chain incident mode. Given an advisory id (MAL-, GHSA-, CVE-) or package@range, report: whether it is in this project (direct or transitive, versions, parent chain, production or development, install scripts); when each affected version entered and left the lockfiles in git history and which branches and tags could have installed it; a rollback to the newest version outside the affected range (recorded as a plan with plan: true, never applied); and a checklist of the secret names CI, containers and env templates put in reach of an install (names only, never values; a checklist to review, not a finding of compromise). Changes nothing unless plan or outputDir is set. Works offline for package@range.",
    input: incidentInput,
    annotations: ANALYSIS,
    response: response("IncidentReport", {
      schemaVersion: { type: "string" },
      target: { type: "object" },
      exposure: { type: "object" },
      history: { type: "object" },
      rollback: { type: "object" },
      secrets: { type: "object" },
      files: { type: "object" },
    }),
    mcp: true,
    http: { method: "POST", path: "/incident", positional: ["target"] },
    handler: ({ target, ...options }, context) =>
      context.api.incidentFn(target, { ...options, source: context.source }),
  }),
  defineOperation({
    name: "premortem",
    title: "Compromise pre-mortem",
    description:
      "What if this package is compromised tomorrow? Across repository checkouts (a portfolio targets list, or every repository under a root), report for the given packages (or the most depended-upon or most privileged ones) which repositories lock them, directly or transitively, in which versions, whether they run install scripts, and whether CI installs run with secrets in reach. With outputDir, writes a playbook per repository or per package with the exact commands to run on the day, meant to be committed. Reads checkouts only; no network.",
    input: premortemInput,
    annotations: { ...ANALYSIS, openWorldHint: false },
    response: response("PremortemReport", {
      schemaVersion: { type: "string" },
      repos: { type: "array", items: { type: "object" } },
      packages: { type: "array", items: { type: "object" } },
      selection: { type: "object" },
      files: { type: "array", items: { type: "string" } },
    }),
    mcp: true,
    http: { method: "POST", path: "/premortem", positional: [] },
    handler: (options, context) => context.api.premortemFn(options),
  }),
];
