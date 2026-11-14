import { describe, expect, it } from "vitest";

import { addRemediateDispositionStep } from "./remediate.evidence.js";

describe("addRemediateDispositionStep", () => {
  it("does not pollute prototypes through attacker-controlled package names", () => {
    const steps: unknown[] = [];
    const evidence = { steps } as unknown as Parameters<typeof addRemediateDispositionStep>[0];
    const report = {
      results: [{ packageName: "__proto__", disposition: "auto-apply" }],
    } as unknown as Parameters<typeof addRemediateDispositionStep>[2];

    addRemediateDispositionStep(evidence, "__proto__", report);

    expect(({} as Record<string, unknown>)["disposition"]).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("disposition");
  });
});
