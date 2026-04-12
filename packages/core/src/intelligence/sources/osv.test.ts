import { describe, expect, it, vi } from "vitest";
import { parseOsvVuln, lookupCveOsv } from "./osv.js";

describe("osv source", () => {
  it("parses npm affected package ranges and fixed versions", () => {
    const details = parseOsvVuln({
      id: "CVE-2021-23337",
      summary: "Prototype pollution",
      severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/9.8" }],
      references: [{ type: "WEB", url: "https://osv.dev/example" }],
      affected: [
        {
          package: { name: "lodash", ecosystem: "npm" },
          ranges: [
            {
              type: "SEMVER",
              events: [{ introduced: "0" }, { fixed: "4.17.21" }],
            },
          ],
        },
      ],
    } as any);

    expect(details.id).toBe("CVE-2021-23337");
    expect(details.severity).toBe("CRITICAL");
    expect(details.references).toEqual(["https://osv.dev/example"]);
    expect(details.affectedPackages).toHaveLength(1);
    expect(details.affectedPackages[0]?.name).toBe("lodash");
    expect(details.affectedPackages[0]?.vulnerableRange).toBe(">=0.0.0 <4.17.21");
    expect(details.affectedPackages[0]?.firstPatchedVersion).toBe("4.17.21");
  });

  it("lookupCveOsv returns null on 404", async () => {
    globalThis.fetch = vi
      .fn(async () => ({ status: 404, ok: false, text: async () => "" })) as any;
    const result = await lookupCveOsv("CVE-2099-0001");
    expect(result).toBeNull();
  });
});
