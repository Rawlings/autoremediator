import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "./program.js";

let stdout: string;
beforeEach(() => {
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

const run = (...args: string[]) =>
  createProgram().parseAsync(["node", "autoremediator", "radar", ...args]);

describe("autoremediator radar", () => {
  it("is registered with the documented flags", () => {
    const command = createProgram().commands.find((entry) => entry.name() === "radar");
    expect(command?.options.map((option) => option.long).toSorted()).toEqual(
      [
        "--cwd",
        "--github",
        "--include-transitive",
        "--limit",
        "--max-packages",
        "--model",
        "--no-assess",
        "--offline",
        "--output-format",
        "--target",
      ].toSorted(),
    );
  });

  it("refuses --offline before touching the network", async () => {
    await expect(run("--offline")).rejects.toThrow(/cannot run offline/);
  });

  it("rejects an unknown --target and an unknown output format", async () => {
    await expect(run("--target", "next")).rejects.toThrow(
      /--target must be one of latest, minor, patch/,
    );
    await expect(run("--output-format", "xml")).rejects.toThrow(
      /radar supports --output-format text\|json/,
    );
  });

  it("needs a value or AUTOREMEDIATOR_MODEL for a bare --model", async () => {
    vi.stubEnv("AUTOREMEDIATOR_MODEL", "");
    await expect(run("--model")).rejects.toThrow(/--model needs a value/);
    expect(stdout).toBe("");
  });
});
