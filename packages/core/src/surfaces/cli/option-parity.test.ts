import { describe, expect, it } from "vitest";
import type { z } from "zod";

import type { remediateOptionsSchema } from "../../features/remediate/option-schemas.js";
import { toRemediateOptions } from "./commands/remediate.js";
import { createProgram } from "./program.js";
import type { CommandOptions } from "./types.js";

type WireOption = keyof z.input<typeof remediateOptionsSchema>;

/**
 * Where each option of the wire schema (what MCP and HTTP accept) lives on the CLI. Typing this as
 * a complete record makes adding an option to the schema a compile error until someone decides how
 * the CLI exposes it, which is how `kevMandatory` and friends drifted apart before.
 */
const CLI_FLAGS: Record<WireOption, readonly string[] | { none: string }> = {
  cwd: ["--cwd"],
  packageManager: ["--package-manager"],
  dryRun: ["--dry-run"],
  preview: ["--preview"],
  simulationMode: ["--simulation-mode"],
  runTests: ["--run-tests"],
  typecheck: ["--typecheck"],
  supplyChainPolicy: { none: "set under constraints.supplyChainPolicy in the policy file" },
  model: ["--model"],
  patchConfidenceThresholds: [
    "--patch-confidence-low",
    "--patch-confidence-medium",
    "--patch-confidence-high",
  ],
  patchesDir: ["--patches-dir"],
  policy: ["--policy"],
  evidence: ["--evidence", "--no-evidence"],
  requestId: ["--request-id"],
  sessionId: ["--session-id"],
  parentRunId: ["--parent-run-id"],
  idempotencyKey: ["--idempotency-key"],
  resume: ["--resume"],
  actor: ["--actor"],
  source: ["--source"],
  constraints: [
    "--direct-dependencies-only",
    "--prefer-version-bump",
    "--install-mode",
    "--install-prefer-offline",
    "--enforce-frozen-lockfile",
    "--workspace",
  ],
  changeRequest: [
    "--create-change-request",
    "--change-request-provider",
    "--change-request-grouping",
    "--change-request-repository",
    "--change-request-base-branch",
    "--change-request-branch-prefix",
    "--change-request-title-prefix",
  ],
  exploitSignalOverride: ["--kev-mandatory", "--epss-threshold"],
  suppressionsFile: ["--suppressions-file"],
  slaCheck: ["--sla-check"],
  skipUnreachable: ["--skip-unreachable"],
  dispositionPolicy: [
    "--min-confidence-for-auto-apply",
    "--hold-for-transitive",
    "--escalate-on-kev",
  ],
  containmentMode: ["--containment-mode"],
  campaignMode: ["--campaign-mode"],
  escalationGraph: { none: "set in the policy file" },
  offlineIntelligence: ["--offline"],
  intelligenceSnapshotPath: ["--intelligence-snapshot"],
  proofOfFix: ["--proof-of-fix"],
  requireProofOfFix: ["--require-proof-of-fix"],
  reproductionTest: ["--reproduction-test"],
  breakingChangeRefactor: ["--breaking-change-refactor"],
};

/** Flags that control the CLI itself rather than set an SDK option. */
const CLI_ONLY_FLAGS = [
  "--interactive",
  "--audit",
  "--ci",
  "--output-format",
  // SDK and CLI only, not on the wire: an agent must not be able to lift a person's memory constraints.
  "--ignore-memory",
];

const cveFlags = () =>
  new Set(
    createProgram()
      .commands.find((command) => command.name() === "cve")!
      .options.map((option) => option.long!),
  );

describe("CLI flags and the wire option schema", () => {
  it("exposes every option the table says it does", () => {
    const flags = cveFlags();
    for (const [option, where] of Object.entries(CLI_FLAGS)) {
      if (Array.isArray(where)) {
        for (const flag of where) expect([option, flags.has(flag)]).toEqual([option, true]);
      }
    }
  });

  it("has no flag the table does not account for", () => {
    const known = new Set<string>([
      ...Object.values(CLI_FLAGS).flatMap((where) => (Array.isArray(where) ? where : [])),
      ...CLI_ONLY_FLAGS,
    ]);
    const unaccounted = [...cveFlags()].filter((flag) => !known.has(flag));
    expect(unaccounted).toEqual([]);
  });

  it("explains every option that has no flag", () => {
    const reasons = Object.values(CLI_FLAGS).flatMap((where) =>
      Array.isArray(where) ? [] : [(where as { none: string }).none],
    );
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((reason) => reason.length > 10)).toBe(true);
  });
});

describe("toRemediateOptions", () => {
  const base = {
    cwd: "/p",
    dryRun: false,
    preview: false,
    simulationMode: false,
    runTests: false,
    resume: false,
    directDependenciesOnly: false,
    preferVersionBump: false,
    audit: false,
    format: "auto",
    evidence: true,
    ci: false,
    offline: false,
    outputFormat: "text",
  } as unknown as CommandOptions;

  it("forwards every flag, so no command silently drops one", () => {
    const options = toRemediateOptions({
      ...base,
      typecheck: true,
      model: "anthropic:claude-sonnet-5-5",
      patchConfidenceHigh: 0.9,
      kevMandatory: true,
      epssThreshold: 0.4,
      minConfidenceForAutoApply: 0.8,
      offline: true,
      intelligenceSnapshot: "/p/intel.json",
      proofOfFix: true,
      requireProofOfFix: true,
      reproductionTest: "/p/repro.js",
      breakingChangeRefactor: true,
      createChangeRequest: true,
      changeRequestGrouping: "per-cve",
      campaignMode: true,
    });

    expect(options).toMatchObject({
      typecheck: true,
      model: "anthropic:claude-sonnet-5-5",
      patchConfidenceThresholds: { high: 0.9 },
      exploitSignalOverride: {
        kev: { mandatory: true },
        epss: { mandatory: true, threshold: 0.4 },
      },
      dispositionPolicy: { minConfidenceForAutoApply: 0.8 },
      offlineIntelligence: true,
      intelligenceSnapshotPath: "/p/intel.json",
      proofOfFix: true,
      requireProofOfFix: true,
      reproductionTest: "/p/repro.js",
      breakingChangeRefactor: true,
      changeRequest: { enabled: true, provider: "github", grouping: "per-cve" },
      campaignMode: true,
      source: "cli",
    });
  });
});
