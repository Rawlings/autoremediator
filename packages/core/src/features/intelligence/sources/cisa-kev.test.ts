import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CveDetails } from "../types.js";
import { clearCisaKevCache, enrichWithCisaKev, findKevEntry } from "./cisa-kev.js";

describe("cisa-kev source", () => {
  it("finds a matching CVE in the KEV feed", () => {
    const feed = {
      vulnerabilities: [
        {
          cveID: "CVE-2021-23337",
          dateAdded: "2022-01-01",
          dueDate: "2022-01-21",
          requiredAction: "Apply updates",
          knownRansomwareCampaignUse: "Unknown",
        },
      ],
    };

    const entry = findKevEntry(feed, "cve-2021-23337");
    expect(entry).toBeDefined();
    expect(entry?.cveID).toBe("CVE-2021-23337");
  });

  it("returns undefined when the CVE is not in the feed", () => {
    const feed = {
      vulnerabilities: [{ cveID: "CVE-2020-11111" }],
    };

    const entry = findKevEntry(feed, "CVE-2021-23337");
    expect(entry).toBeUndefined();
  });
});

describe("cisa-kev feed caching", () => {
  const details = (id: string): CveDetails => ({
    id,
    summary: "",
    severity: "HIGH",
    affectedPackages: [],
    references: [],
  });
  const feedResponse = () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({ vulnerabilities: [{ cveID: "CVE-2021-23337", dateAdded: "2022-01-01" }] }),
  });

  beforeEach(() => {
    clearCisaKevCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearCisaKevCache();
  });

  it("downloads the feed once for many advisories, including concurrent ones", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => feedResponse());
    vi.stubGlobal("fetch", fetchMock);

    const [hit, miss] = await Promise.all([
      enrichWithCisaKev(details("CVE-2021-23337")),
      enrichWithCisaKev(details("CVE-2020-00001")),
    ]);
    await enrichWithCisaKev(details("CVE-2021-23337"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hit.kev?.knownExploited).toBe(true);
    expect(miss.kev).toBeUndefined();
  });

  it("does not cache a failed download", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async () => feedResponse());
    vi.stubGlobal("fetch", fetchMock);

    expect((await enrichWithCisaKev(details("CVE-2021-23337"))).kev).toBeUndefined();
    expect((await enrichWithCisaKev(details("CVE-2021-23337"))).kev?.knownExploited).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes the feed after the cache expires", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => feedResponse());
    vi.stubGlobal("fetch", fetchMock);

    await enrichWithCisaKev(details("CVE-2021-23337"));
    vi.advanceTimersByTime(61 * 60 * 1000);
    await enrichWithCisaKev(details("CVE-2021-23337"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
