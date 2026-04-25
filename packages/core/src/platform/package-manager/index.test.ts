import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mocked.existsSync,
}));

import { detectPackageManager, resolveAuditCommand, resolveDedupeCommand, resolveInstallCommand, resolveListCommand, resolveTestCommand, resolveWhyCommand } from "./index.js";

describe("detectPackageManager", () => {
  it("detects pnpm from pnpm-lock.yaml", () => {
    mocked.existsSync.mockImplementation((p: string) => p.endsWith("pnpm-lock.yaml"));
    expect(detectPackageManager("/project")).toBe("pnpm");
  });

  it("detects yarn from yarn.lock", () => {
    mocked.existsSync.mockImplementation((p: string) => p.endsWith("yarn.lock"));
    expect(detectPackageManager("/project")).toBe("yarn");
  });

  it("detects bun from bun.lockb", () => {
    mocked.existsSync.mockImplementation((p: string) => p.endsWith("bun.lockb"));
    expect(detectPackageManager("/project")).toBe("bun");
  });

  it("detects bun from bun.lock", () => {
    mocked.existsSync.mockImplementation((p: string) => p.endsWith("bun.lock"));
    expect(detectPackageManager("/project")).toBe("bun");
  });

  it("detects deno from deno.lock", () => {
    mocked.existsSync.mockImplementation((p: string) => p.endsWith("deno.lock"));
    expect(detectPackageManager("/project")).toBe("deno");
  });

  it("defaults to npm when no lockfile found", () => {
    mocked.existsSync.mockReturnValue(false);
    expect(detectPackageManager("/project")).toBe("npm");
  });

  it("pnpm-lock.yaml takes precedence over yarn.lock", () => {
    mocked.existsSync.mockImplementation(
      (p: string) => p.endsWith("pnpm-lock.yaml") || p.endsWith("yarn.lock")
    );
    expect(detectPackageManager("/project")).toBe("pnpm");
  });

  it("yarn.lock takes precedence over bun.lockb", () => {
    mocked.existsSync.mockImplementation(
      (p: string) => p.endsWith("yarn.lock") || p.endsWith("bun.lockb")
    );
    expect(detectPackageManager("/project")).toBe("yarn");
  });

  it("bun.lockb takes precedence over deno.lock", () => {
    mocked.existsSync.mockImplementation(
      (p: string) => p.endsWith("bun.lockb") || p.endsWith("deno.lock")
    );
    expect(detectPackageManager("/project")).toBe("bun");
  });
});

describe("resolveInstallCommand", () => {
  it("bun deterministic uses --frozen-lockfile", () => {
    expect(resolveInstallCommand("bun", { installMode: "deterministic" })).toEqual([
      "bun", "install", "--frozen-lockfile",
    ]);
  });

  it("bun standard install has no frozen flag", () => {
    expect(resolveInstallCommand("bun", { installMode: "standard" })).toEqual(["bun", "install"]);
  });

  it("deno deterministic uses --frozen", () => {
    expect(resolveInstallCommand("deno", { installMode: "deterministic" })).toEqual([
      "deno", "install", "--frozen",
    ]);
  });

  it("deno prefer-offline uses --cache-only", () => {
    expect(resolveInstallCommand("deno", { installMode: "prefer-offline" })).toEqual([
      "deno", "install", "--cache-only",
    ]);
  });
});

describe("resolveListCommand", () => {
  it("bun returns bun pm ls --all", () => {
    expect(resolveListCommand("bun")).toEqual(["bun", "pm", "ls", "--all"]);
  });

  it("deno returns empty array (lock-file-based inventory)", () => {
    expect(resolveListCommand("deno")).toEqual([]);
  });
});

describe("resolveTestCommand", () => {
  it("bun returns bun test", () => {
    expect(resolveTestCommand("bun")).toEqual(["bun", "test"]);
  });

  it("deno returns deno test", () => {
    expect(resolveTestCommand("deno")).toEqual(["deno", "test"]);
  });
});

describe("resolveAuditCommand", () => {
  it("bun returns bun audit --json", () => {
    expect(resolveAuditCommand("bun")).toEqual(["bun", "audit", "--json"]);
  });

  it("deno throws a clear error", () => {
    expect(() => resolveAuditCommand("deno")).toThrow(
      /Deno does not support a native audit command/
    );
  });
});

describe("resolveWhyCommand", () => {
  it("bun returns bun pm why <pkg>", () => {
    expect(resolveWhyCommand("bun", "lodash")).toEqual(["bun", "pm", "why", "lodash"]);
  });

  it("deno returns empty array", () => {
    expect(resolveWhyCommand("deno", "lodash")).toEqual([]);
  });
});

describe("resolveDedupeCommand", () => {
  it("bun returns empty array", () => {
    expect(resolveDedupeCommand("bun")).toEqual([]);
  });

  it("deno returns empty array", () => {
    expect(resolveDedupeCommand("deno")).toEqual([]);
  });

  it("npm returns npm dedupe", () => {
    expect(resolveDedupeCommand("npm")).toEqual(["npm", "dedupe"]);
  });
});
