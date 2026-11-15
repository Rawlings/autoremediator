import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendTrackEvents } from "../autonomy/record.js";
import { formatAutonomyLine, runAutonomy } from "./autonomy.js";
import { createProgram } from "./program.js";

let dir: string;
let output: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-autonomy-"));
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const policy = (yaml: string) => {
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, ".github/autoremediator.yml"), yaml);
};
const runId = (n: number) => `run_${String(n).padStart(20, "0")}`;
const event = (n: number, type: "applied-verified" | "rollback" = "applied-verified") => ({
  type,
  runId: runId(n),
  cveIds: ["CVE-2021-23337"],
  packages: ["lodash"],
  coverage: { tests: true, typecheck: false },
  detail: "lodash 4.17.20 -> 4.17.21",
});

describe("autonomy status and explain", () => {
  it("says the feature is off when the policy has no autonomy key", async () => {
    await runAutonomy("status", { cwd: dir, outputFormat: "text" });
    expect(output).toContain("earned autonomy is off");
  });

  it("status shows the level, the ceiling, the evidence and what the next level needs", async () => {
    policy("autonomy:\n  ceiling: L3\n");
    await appendTrackEvents(dir, [event(1), event(2)]);
    await runAutonomy("status", { cwd: dir, outputFormat: "text" });

    expect(output).toContain("Autonomy L2 (open pull request); ceiling L3, earned L2");
    expect(output).toContain("Allows: planning yes, applying changes yes");
    expect(output).toContain("verified 2 (tests passed in 2, type check in 0)");
    expect(output).toContain("Next: L3 needs");
    expect(output).toContain("unmet  verified runs: at least 5 (now 2)");
  });

  it("explain adds the reasons, the settings and the history with its cause", async () => {
    policy("autonomy:\n  ceiling: L3\n  minVerifiedRuns: 2\n  window: 4\n");
    await appendTrackEvents(dir, [event(1), event(2), event(3, "rollback")]);
    await runAutonomy("explain", { cwd: dir, outputFormat: "text" });

    expect(output).toContain("Autonomy L1 (suggest); ceiling L3, earned L1");
    expect(output).toContain("Why this level");
    expect(output).toContain("rollback on");
    expect(output).toContain("Settings (policy file `autonomy`)");
    expect(output).toContain("minVerifiedRuns 2");
    expect(output).toMatch(/promotion L2 -> L3 {2}\(event #2\)/);
    expect(output).toMatch(/demotion L3 -> L1 {2}\(event #3\)/);
    expect(output).toContain(`runs: ${runId(3)}`);
  });

  it("prints JSON with --output-format json", async () => {
    policy("autonomy:\n  ceiling: L1\n");
    await runAutonomy("status", { cwd: dir, outputFormat: "json" });
    const parsed = JSON.parse(output) as {
      configured: boolean;
      level: string;
      earned: string;
      allows: { apply: boolean };
    };
    expect(parsed).toMatchObject({
      configured: true,
      level: "L1",
      earned: "L2",
      allows: { plan: true, apply: false },
    });
  });

  it("reads the policy named by --policy", async () => {
    writeFileSync(join(dir, "other.yml"), "autonomy:\n  ceiling: L0\n");
    await runAutonomy("status", { cwd: dir, outputFormat: "text", policy: join(dir, "other.yml") });
    expect(output).toContain("Autonomy L0 (observe)");
  });

  it("is wired into the program as `autonomy status|explain`", () => {
    const autonomy = createProgram().commands.find((command) => command.name() === "autonomy")!;
    expect(autonomy.commands.map((command) => command.name())).toEqual(["status", "explain"]);
  });

  it("formats the line reports carry", () => {
    expect(
      formatAutonomyLine({
        level: "L4",
        ceiling: "L4",
        earned: "L4",
        name: "autonomous with escalation",
        autoMergeEligible: true,
        escalate: true,
        note: "n",
      }),
    ).toBe(
      "Autonomy: L4 (autonomous with escalation); ceiling L4, earned L4; auto-merge eligible, escalate to a person. n",
    );
  });
});
