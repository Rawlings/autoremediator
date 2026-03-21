import { describe, expect, it } from "vitest";
import { findKevEntry } from "./cisa-kev.js";

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
