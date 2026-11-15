import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProveResult } from "../api/index.js";
import { describeProve } from "./prove-commands.js";
import { createProgram } from "./program.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prove-cli-"));
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

const run = (...args: string[]) => createProgram().parseAsync(["node", "autoremediator", ...args]);

const base = {
  schemaVersion: "1.0",
  advisoryId: "GHSA-ABCD-EFGH-IJKL",
  package: "lodash",
  vulnerableVersion: "4.17.18",
  fixedVersion: "4.17.19",
  usage: [],
  agent: { id: "builtin:m", status: "stopped", rationale: "" },
  sandbox: {},
} as unknown as ProveResult;

describe("autoremediator prove", () => {
  it("is a command with the options the task names", () => {
    const command = createProgram().commands.find((candidate) => candidate.name() === "prove")!;
    expect(command.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--package", "--model", "--signing-key", "--patches-dir", "--fixed-version", "--vulnerable-version"]),
    );
  });

  it("says plainly that it needs a model when none is configured, before doing anything", async () => {
    const saved = process.env["AUTOREMEDIATOR_MODEL"];
    delete process.env["AUTOREMEDIATOR_MODEL"];
    try {
      await expect(run("prove", "GHSA-abcd-efgh-ijkl", "--package", "lodash", "--cwd", dir)).rejects.toThrow(
        /needs a model/,
      );
    } finally {
      if (saved !== undefined) process.env["AUTOREMEDIATOR_MODEL"] = saved;
    }
  });

  it("rejects an unknown output format", async () => {
    await expect(run("prove", "GHSA-abcd-efgh-ijkl", "--cwd", dir, "--output-format", "xml")).rejects.toThrow();
  });
});

describe("describeProve", () => {
  it("reports a kept script with where it is and what it does not show", () => {
    const text = describeProve({
      ...base,
      status: "kept",
      reason: "ok",
      trials: [{ attempt: 1, accepted: true, stage: "confirmed", reason: "Fails on lodash@4.17.18 and passes on lodash@4.17.19, 2 times each.", scriptSha256: "x" }],
      files: { script: "patches/lodash+4.17.18.test.cjs", evidence: "patches/lodash+4.17.18.proof.json", signature: "patches/lodash+4.17.18.proof.json.sig" },
    });
    expect(text).toContain("Kept. Script: patches/lodash+4.17.18.test.cjs");
    expect(text).toContain("Signature: patches/lodash+4.17.18.proof.json.sig");
    expect(text).toContain("cannot show that the difference is the advisory's vulnerability");
  });

  it("reports why nothing was kept", () => {
    const text = describeProve({
      ...base,
      status: "rejected",
      reason: "No script was kept: the agent proposed none (gave-up: needs a network service).",
      trials: [],
      agent: { id: "builtin:m", status: "gave-up", rationale: "needs a network service" },
    });
    expect(text).toContain("no script was proposed (gave-up: needs a network service)");
    expect(text).toContain("Not proven.");
    expect(text).not.toContain("Kept.");
  });
});
