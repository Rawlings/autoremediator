import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPolicyCompile } from "./policy-commands.js";
import { createProgram } from "./program.js";

let dir: string;
let stdout: string;
const file = () => join(dir, ".github/autoremediator.yml");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "policy-cli-"));
  mkdirSync(join(dir, ".github"));
  writeFileSync(file(), "# keep me\nallowMajorBumps: false\n");
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const ANSWER = {
  patch: { denyPackages: { add: ["left-pad"] } },
  explanations: [{ phrase: "don't touch left-pad", keys: ["denyPackages"] }],
  unsupported: [{ phrase: "in payments", reason: "No per-path scoping." }],
};
const compileOptions = { proposer: async () => ANSWER, now: new Date("2026-11-15") };
const base = () => ({ cwd: dir, outputFormat: "text" as const });

describe("autoremediator policy compile", () => {
  it("shows the diff and what could not be expressed, and writes nothing without --yes (exit 3)", async () => {
    await runPolicyCompile(["don't", "touch", "left-pad", "in", "payments"], {
      ...base(),
      compileOptions,
      interactive: false,
    });
    expect(stdout).toContain("Proposed change to .github/autoremediator.yml");
    expect(stdout).toContain("+  - left-pad");
    expect(stdout).toContain("Could not be expressed");
    expect(stdout).toContain('"in payments"');
    expect(stdout).toContain("Nothing written. Run again with --yes");
    expect(process.exitCode).toBe(3);
    expect(readFileSync(file(), "utf8")).toBe("# keep me\nallowMajorBumps: false\n");
  });

  it("writes with --yes, keeping comments", async () => {
    await runPolicyCompile(["don't touch left-pad in payments"], {
      ...base(),
      yes: true,
      compileOptions,
    });
    expect(stdout).toContain("Wrote .github/autoremediator.yml");
    expect(process.exitCode).toBeUndefined();
    const text = readFileSync(file(), "utf8");
    expect(text).toContain("# keep me");
    expect(text).toContain("left-pad");
  });

  it("asks a person at a terminal and writes only on yes", async () => {
    const no = vi.fn(async () => false);
    await runPolicyCompile(["don't touch left-pad in payments"], {
      ...base(),
      compileOptions,
      interactive: true,
      confirm: no,
    });
    expect(no).toHaveBeenCalledOnce();
    expect(readFileSync(file(), "utf8")).not.toContain("left-pad");
    expect(process.exitCode).toBe(3);

    process.exitCode = undefined;
    await runPolicyCompile(["don't touch left-pad in payments"], {
      ...base(),
      compileOptions,
      interactive: true,
      confirm: async () => true,
    });
    expect(readFileSync(file(), "utf8")).toContain("left-pad");
    expect(process.exitCode).toBe(0);
  });

  it("exits 1 for a rejected proposal, with --yes or not, and leaves the file alone", async () => {
    await runPolicyCompile(["don't touch left-pad"], {
      ...base(),
      yes: true,
      compileOptions: { ...compileOptions, proposer: async () => ({ patch: { telemetry: true } }) },
    });
    expect(stdout).toContain("Rejected");
    expect(stdout).toContain("telemetry");
    expect(process.exitCode).toBe(1);
    expect(readFileSync(file(), "utf8")).toBe("# keep me\nallowMajorBumps: false\n");
  });

  it("lists a loosening and refuses it without --allow-loosening", async () => {
    const loosen = {
      patch: { allowMajorBumps: true },
      explanations: [{ phrase: "allow major upgrades", keys: ["allowMajorBumps"] }],
      unsupported: [],
    };
    await runPolicyCompile(["allow major upgrades"], {
      ...base(),
      yes: true,
      compileOptions: { ...compileOptions, proposer: async () => loosen },
    });
    expect(stdout).toContain("LESS SAFE than before");
    expect(stdout).toContain("--allow-loosening");
    expect(process.exitCode).toBe(1);

    stdout = "";
    process.exitCode = undefined;
    await runPolicyCompile(["allow major upgrades"], {
      ...base(),
      yes: true,
      allowLoosening: true,
      compileOptions: { ...compileOptions, proposer: async () => loosen },
    });
    expect(stdout).toContain("LESS SAFE than before");
    expect(readFileSync(file(), "utf8")).toContain("allowMajorBumps: true");
  });

  it("prints JSON", async () => {
    await runPolicyCompile(["don't touch left-pad"], {
      ...base(),
      outputFormat: "json",
      compileOptions,
    });
    const parsed = JSON.parse(stdout) as { status: string; diff: string };
    expect(parsed.status).toBe("proposed");
    expect(parsed.diff).toContain("left-pad");
  });

  it("is registered, and says it needs a model when there is none", async () => {
    vi.stubEnv("AUTOREMEDIATOR_MODEL", "");
    const program = createProgram().exitOverride();
    const policy = program.commands.find((command) => command.name() === "policy");
    expect(policy?.commands.map((command) => command.name()).toSorted()).toEqual([
      "compile",
      "explain",
    ]);
    await expect(
      program.parseAsync(["node", "autoremediator", "policy", "compile", "x", "--cwd", dir]),
    ).rejects.toThrow(/AUTOREMEDIATOR_MODEL/);
    vi.unstubAllEnvs();
  });
});

describe("autoremediator policy explain", () => {
  it("prints the policy as sentences, and as JSON", async () => {
    writeFileSync(file(), "denyPackages: [left-pad]\ncontainmentMode: true\n");
    await createProgram().parseAsync(["node", "autoremediator", "policy", "explain", "--cwd", dir]);
    expect(stdout).toContain("Never touch these packages: left-pad.");
    expect(stdout).toContain("rolled back");

    stdout = "";
    await createProgram().parseAsync([
      "node",
      "autoremediator",
      "policy",
      "explain",
      "--cwd",
      dir,
      "--output-format",
      "json",
    ]);
    expect((JSON.parse(stdout) as { exists: boolean }).exists).toBe(true);
  });
});
