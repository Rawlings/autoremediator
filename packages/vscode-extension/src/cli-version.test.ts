import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CLI_VERSION } from "./cli-version.js";

describe("CLI_VERSION", () => {
  it("is the version of the core package it runs", () => {
    const core = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "core", "package.json"), "utf8"),
    ) as { version: string };
    expect(CLI_VERSION).toBe(core.version);
  });
});
