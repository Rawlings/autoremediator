import { describe, expect, it, vi, beforeEach } from "vitest";
import { loadIntelligenceSnapshot, lookupSnapshotCve } from "./snapshot.js";
import type { CveDetails } from "../../platform/types.js";

vi.mock("node:fs");

const mockCveDetails: CveDetails = {
  id: "CVE-2021-1234",
  summary: "Test CVE",
  severity: "HIGH",
  references: [],
  affectedPackages: [
    {
      name: "test-pkg",
      ecosystem: "npm",
      vulnerableRange: ">=0.0.0 <1.0.0",
      firstPatchedVersion: "1.0.0",
      source: "osv",
    },
  ],
};

describe("loadIntelligenceSnapshot", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns object for valid JSON snapshot", async () => {
    const { readFileSync } = await import("node:fs");
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ "CVE-2021-1234": mockCveDetails })
    );
    const snapshot = loadIntelligenceSnapshot("/tmp/snapshot.json");
    expect(snapshot).toEqual({ "CVE-2021-1234": mockCveDetails });
  });

  it("throws when snapshot is not a JSON object (string)", async () => {
    const { readFileSync } = await import("node:fs");
    vi.mocked(readFileSync).mockReturnValue('"not an object"');
    expect(() => loadIntelligenceSnapshot("/tmp/snapshot.json")).toThrow(
      "must be a JSON object keyed by CVE ID"
    );
  });

  it("throws when snapshot is an array", async () => {
    const { readFileSync } = await import("node:fs");
    vi.mocked(readFileSync).mockReturnValue("[]");
    expect(() => loadIntelligenceSnapshot("/tmp/snapshot.json")).toThrow(
      "must be a JSON object keyed by CVE ID"
    );
  });

  it("throws when snapshot is null", async () => {
    const { readFileSync } = await import("node:fs");
    vi.mocked(readFileSync).mockReturnValue("null");
    expect(() => loadIntelligenceSnapshot("/tmp/snapshot.json")).toThrow(
      "must be a JSON object keyed by CVE ID"
    );
  });
});

describe("lookupSnapshotCve", () => {
  const snapshot = {
    "CVE-2021-1234": mockCveDetails,
  };

  it("returns entry when key is present (uppercase)", () => {
    const result = lookupSnapshotCve(snapshot, "CVE-2021-1234");
    expect(result).toBe(mockCveDetails);
  });

  it("returns null when key is absent", () => {
    const result = lookupSnapshotCve(snapshot, "CVE-2099-9999");
    expect(result).toBeNull();
  });

  it("is case-insensitive: lowercased CVE ID matches uppercase key", () => {
    const result = lookupSnapshotCve(snapshot, "cve-2021-1234");
    expect(result).toBe(mockCveDetails);
  });

  it("is case-insensitive: mixed case CVE ID matches uppercase key", () => {
    const result = lookupSnapshotCve(snapshot, "Cve-2021-1234");
    expect(result).toBe(mockCveDetails);
  });
});
