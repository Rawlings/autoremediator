import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectPackageManager,
  getYarnMajorVersion,
  resolveDedupeCommand,
  resolveAuditCommand,
  resolveInstallCommand,
  resolveWhyCommand,
} from "./package-manager/index.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

// Lazily import the mocked execa so tests can control its return value.
import { execa } from "execa";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("package-manager commands", () => {
  it("scopes npm audit command to workspace when provided", () => {
    const command = resolveAuditCommand("npm", {
      workspace: "web-app",
    });

    expect(command).toEqual(["npm", "audit", "--json", "--workspace", "web-app"]);
  });

  it("scopes pnpm audit command with filter when workspace is provided", () => {
    const command = resolveAuditCommand("pnpm", {
      workspace: "@apps/web",
    });

    expect(command).toEqual(["pnpm", "--filter", "@apps/web", "audit", "--json"]);
  });

  it("resolves npm explain command for dependency path diagnostics", () => {
    const command = resolveWhyCommand("npm", "minimist");
    expect(command).toEqual(["npm", "explain", "minimist"]);
  });

  it("resolves pnpm why command with workspace filter", () => {
    const command = resolveWhyCommand("pnpm", "minimist", { workspace: "@apps/web" });
    expect(command).toEqual(["pnpm", "--filter", "@apps/web", "why", "minimist"]);
  });

  it("resolves npm dedupe command with workspace", () => {
    const command = resolveDedupeCommand("npm", { workspace: "web-app" });
    expect(command).toEqual(["npm", "dedupe", "--workspace", "web-app"]);
  });
});

describe("resolveInstallCommand", () => {
  // Installs run after the manifest changed, so the lockfile must be allowed to change.
  it.each([
    ["npm", {}, ["npm", "install", "--prefer-offline"]],
    ["pnpm", {}, ["pnpm", "install", "--no-frozen-lockfile", "--prefer-offline"]],
    ["yarn", {}, ["yarn", "install"]],
    ["bun", {}, ["bun", "install"]],
    ["deno", {}, ["deno", "install"]],
  ] as const)("never freezes the lockfile by default (%s)", (pm, constraints, expected) => {
    expect(resolveInstallCommand(pm, constraints)).toEqual(expected);
  });

  it("does not freeze even in the default deterministic install mode", () => {
    const command = resolveInstallCommand("npm", { installMode: "deterministic" });
    expect(command).not.toContain("ci");
    expect(command).not.toContain("--frozen-lockfile");
  });

  it("only uses prefer-offline when the mode or override asks for it", () => {
    expect(resolveInstallCommand("npm", { installMode: "standard" })).toEqual(["npm", "install"]);
    expect(resolveInstallCommand("pnpm", { installMode: "standard" })).toEqual([
      "pnpm",
      "install",
      "--no-frozen-lockfile",
    ]);
    expect(
      resolveInstallCommand("npm", { installMode: "standard", installPreferOffline: true }),
    ).toEqual(["npm", "install", "--prefer-offline"]);
    expect(resolveInstallCommand("pnpm", { installPreferOffline: false })).toEqual([
      "pnpm",
      "install",
      "--no-frozen-lockfile",
    ]);
  });

  it("freezes only when explicitly enforced, using each manager's own flag", () => {
    const frozen = { enforceFrozenLockfile: true, installMode: "standard" as const };
    expect(resolveInstallCommand("npm", frozen)).toEqual(["npm", "ci"]);
    expect(resolveInstallCommand("pnpm", frozen)).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(resolveInstallCommand("yarn", frozen, 1)).toEqual([
      "yarn",
      "install",
      "--frozen-lockfile",
    ]);
    expect(resolveInstallCommand("yarn", frozen, 4)).toEqual(["yarn", "install", "--immutable"]);
    expect(resolveInstallCommand("bun", frozen)).toEqual(["bun", "install", "--frozen-lockfile"]);
    expect(resolveInstallCommand("deno", frozen)).toEqual(["deno", "install", "--frozen"]);
  });

  it("opts Yarn Berry out of its implicit CI freeze", () => {
    expect(resolveInstallCommand("yarn", {}, 4)).toEqual(["yarn", "install", "--no-immutable"]);
  });

  it("scopes installs to a workspace", () => {
    expect(
      resolveInstallCommand("npm", { workspace: "packages/app", installMode: "standard" }),
    ).toEqual(["npm", "install", "--workspace", "packages/app"]);
    expect(resolveInstallCommand("pnpm", { workspace: "app", installMode: "standard" })).toEqual([
      "pnpm",
      "--filter",
      "app",
      "install",
      "--no-frozen-lockfile",
    ]);
  });
});

describe("getYarnMajorVersion", () => {
  afterEach(() => {
    vi.mocked(execa).mockReset();
  });

  it("returns 1 for yarn classic v1", async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: "1.22.19", stderr: "" } as never);
    const major = await getYarnMajorVersion("/fake/cwd");
    expect(major).toBe(1);
  });

  it("returns 2 for yarn berry v2", async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: "2.4.3", stderr: "" } as never);
    const major = await getYarnMajorVersion("/fake/cwd");
    expect(major).toBe(2);
  });

  it("returns 4 for yarn berry v4", async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: "4.0.2", stderr: "" } as never);
    const major = await getYarnMajorVersion("/fake/cwd");
    expect(major).toBe(4);
  });

  it("falls back to 1 when yarn --version fails", async () => {
    vi.mocked(execa).mockRejectedValue(new Error("yarn not found"));
    const major = await getYarnMajorVersion("/fake/cwd");
    expect(major).toBe(1);
  });
});

describe("detectPackageManager", () => {
  it("prefers pnpm when lockfile exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ar-pm-"));
    tempDirs.push(cwd);
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    expect(detectPackageManager(cwd)).toBe("pnpm");
  });

  it("uses yarn when yarn lockfile exists and pnpm lockfile does not", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ar-pm-"));
    tempDirs.push(cwd);
    writeFileSync(join(cwd, "yarn.lock"), "# yarn lockfile\n", "utf8");

    expect(detectPackageManager(cwd)).toBe("yarn");
  });

  it("defaults to npm when no lockfile exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ar-pm-"));
    tempDirs.push(cwd);

    expect(detectPackageManager(cwd)).toBe("npm");
  });
});
