import { describe, expect, it } from "vitest";

import type {
  PatchGenerator,
  PatchProposal,
  PatchRequest,
} from "../../platform/patch-generator.js";
import { confidenceThreshold, DEFAULT_CONFIDENCE_THRESHOLDS, generatePatches } from "./generate.js";

const request: PatchRequest = {
  cveId: "CVE-2024-0001",
  packageName: "left-pad",
  vulnerableVersion: "1.0.0",
  cveSummary: "Unsafe padding",
  sourceFiles: { "index.js": "module.exports = (s) => s + 1;\n", "data.json": '{"a":1}\n' },
};

const proposal = (overrides: Partial<PatchProposal> = {}): PatchProposal => ({
  fixedFiles: { "index.js": "module.exports = (s) => s + 2;\n" },
  analysis: "fix",
  confidence: 0.9,
  riskLevel: "low",
  ...overrides,
});

const generatorReturning = (p: PatchProposal): PatchGenerator => ({ propose: async () => p });

describe("generatePatches", () => {
  it("returns a unified diff for each changed file", async () => {
    const outcome = await generatePatches(request, generatorReturning(proposal()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.patches).toHaveLength(1);
    expect(outcome.patches[0]?.filePath).toBe("index.js");
    expect(outcome.patches[0]?.unifiedDiff).toContain("+module.exports = (s) => s + 2;");
  });

  it("reports generator errors as a failure instead of throwing", async () => {
    const outcome = await generatePatches(request, {
      propose: async () => {
        throw new Error("rate limited");
      },
    });
    expect(outcome).toMatchObject({ ok: false, reason: "generator-failed" });
    expect(outcome.ok ? "" : outcome.message).toContain("rate limited");
  });

  it("rejects files that are not part of the package instead of skipping them", async () => {
    const outcome = await generatePatches(
      request,
      generatorReturning(proposal({ fixedFiles: { "invented.js": "x" } })),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "unknown-file" });
  });

  it("rejects syntactically invalid output", async () => {
    const outcome = await generatePatches(
      request,
      generatorReturning(proposal({ fixedFiles: { "index.js": "module.exports = (" } })),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "invalid-syntax" });
  });

  it("rejects a proposal that changes nothing", async () => {
    const outcome = await generatePatches(
      request,
      generatorReturning(
        proposal({ fixedFiles: { "index.js": request.sourceFiles["index.js"]! } }),
      ),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "no-changes" });
  });

  it("enforces a confidence threshold that depends on the assessed risk", async () => {
    const lowConfidence = proposal({ confidence: 0.75, riskLevel: "high" });
    await expect(
      generatePatches(request, generatorReturning(lowConfidence)),
    ).resolves.toMatchObject({
      ok: false,
      reason: "confidence-too-low",
    });
    await expect(
      generatePatches(request, generatorReturning({ ...lowConfidence, riskLevel: "low" })),
    ).resolves.toMatchObject({ ok: true });
  });

  it("honours caller-supplied thresholds", async () => {
    const generator = generatorReturning(proposal({ confidence: 0.75, riskLevel: "high" }));
    await expect(
      generatePatches(request, generator, { confidenceThresholds: { high: 0.7 } }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("confidenceThreshold", () => {
  it("falls back to defaults, clamps overrides and ignores non-finite ones", () => {
    expect(confidenceThreshold("medium")).toBe(DEFAULT_CONFIDENCE_THRESHOLDS.medium);
    expect(confidenceThreshold("medium", { medium: 5 })).toBe(1);
    expect(confidenceThreshold("medium", { medium: -1 })).toBe(0);
    expect(confidenceThreshold("medium", { medium: Number.NaN })).toBe(
      DEFAULT_CONFIDENCE_THRESHOLDS.medium,
    );
  });
});
