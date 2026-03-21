import { describe, expect, it, vi } from "vitest";
import type { CveDetails } from "../../platform/types.js";

import { enrichWithEpss } from "./epss.js";

describe("epss source", () => {
  it("keeps details unchanged when EPSS is unavailable", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false })) as any;
    const details: CveDetails = {
      id: "CVE-2021-23337",
      summary: "x",
      severity: "HIGH",
      references: [],
      affectedPackages: [],
    };

    const out = await enrichWithEpss(details);
    expect(out.epss).toBeUndefined();
  });
});
