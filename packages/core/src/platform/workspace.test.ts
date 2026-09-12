import { describe, expect, it } from "vitest";
import { findWorkspacePackages, findDeclaringWorkspacePackage } from "./workspace.js";

describe("workspace discovery", () => {
  const rootCwd = process.cwd();

  it("finds workspace packages in autoremediator monorepo", () => {
    const workspaces = findWorkspacePackages(rootCwd);
    expect(workspaces.length).toBeGreaterThan(0);
    const names = workspaces.map((w) => w.name);
    expect(names).toContain("autoremediator");
  });

  it("finds declaring package for a known core dependency", () => {
    const pkg = findDeclaringWorkspacePackage(rootCwd, "oxc-parser");
    expect(pkg).not.toBeNull();
    expect(pkg?.name).toBe("autoremediator");
  });

  it("returns null for non-existent dependency in workspaces", () => {
    const pkg = findDeclaringWorkspacePackage(rootCwd, "non-existent-package-xyz-123");
    expect(pkg).toBeNull();
  });
});
