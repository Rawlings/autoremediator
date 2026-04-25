import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  readFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: mocked.readFileSync,
}));

import { parsePackageManagerListOutput, resolveDenoInventory } from "./list-parser.js";

describe("parsePackageManagerListOutput – bun", () => {
  it("parses bun pm ls --all tree-drawing output", () => {
    const stdout = [
      "node_modules",
      "├── lodash@4.17.21",
      "├── minimist@1.2.8",
      "│   └── @scope/dep@2.0.0",
      "└── semver@7.6.0",
    ].join("\n");

    const result = parsePackageManagerListOutput("bun", stdout);

    expect(result.get("lodash")).toBe("4.17.21");
    expect(result.get("minimist")).toBe("1.2.8");
    expect(result.get("@scope/dep")).toBe("2.0.0");
    expect(result.get("semver")).toBe("7.6.0");
  });

  it("returns empty map for empty output", () => {
    const result = parsePackageManagerListOutput("bun", "");
    expect(result.size).toBe(0);
  });

  it("skips lines without @ separator", () => {
    const stdout = "node_modules\n├── justname\n└── lodash@4.17.21";
    const result = parsePackageManagerListOutput("bun", stdout);
    expect(result.has("justname")).toBe(false);
    expect(result.get("lodash")).toBe("4.17.21");
  });
});

describe("resolveDenoInventory – deno.lock v3", () => {
  it("parses packages.npm entries (v3 format)", () => {
    const lock = {
      version: "3",
      packages: {
        npm: {
          "lodash@4.17.21": {},
          "minimist@1.2.8": {},
          "@scope/pkg@2.0.0": {},
        },
      },
    };
    mocked.readFileSync.mockReturnValue(JSON.stringify(lock));

    const result = resolveDenoInventory("/project");

    expect(result.get("lodash")).toBe("4.17.21");
    expect(result.get("minimist")).toBe("1.2.8");
    expect(result.get("@scope/pkg")).toBe("2.0.0");
  });

  it("parses packages with npm: prefix keys (v4 format)", () => {
    const lock = {
      version: "4",
      packages: {
        "npm:lodash@4.17.21": {},
        "npm:minimist@1.2.8": {},
        "npm:@scope/pkg@2.0.0": {},
      },
    };
    mocked.readFileSync.mockReturnValue(JSON.stringify(lock));

    const result = resolveDenoInventory("/project");

    expect(result.get("lodash")).toBe("4.17.21");
    expect(result.get("minimist")).toBe("1.2.8");
    expect(result.get("@scope/pkg")).toBe("2.0.0");
  });

  it("returns empty map when deno.lock does not exist", () => {
    mocked.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = resolveDenoInventory("/project");
    expect(result.size).toBe(0);
  });

  it("returns empty map for invalid JSON", () => {
    mocked.readFileSync.mockReturnValue("not json");
    const result = resolveDenoInventory("/project");
    expect(result.size).toBe(0);
  });
});
