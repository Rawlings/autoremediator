import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createLlmPatchGenerator } from "./llm-generator.js";

const request = {
  cveId: "CVE-2024-0001",
  packageName: "left-pad",
  vulnerableVersion: "1.0.0",
  cveSummary: "Unsafe padding",
  sourceFiles: { "index.js": "module.exports = 1;\n" },
};

function modelAnswering(text: string) {
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 7, text: 7, reasoning: undefined },
      },
      warnings: [],
    },
  });
}

describe("createLlmPatchGenerator", () => {
  it("returns a schema-validated proposal with real token usage", async () => {
    const model = modelAnswering(
      JSON.stringify({
        analysis: "root cause",
        fixedFiles: { "index.js": "module.exports = 2;\n" },
        confidence: 0.8,
        riskLevel: "low",
      }),
    );

    const proposal = await createLlmPatchGenerator(model).propose(request);

    expect(proposal).toMatchObject({
      analysis: "root cause",
      fixedFiles: { "index.js": "module.exports = 2;\n" },
      confidence: 0.8,
      riskLevel: "low",
      usage: { model: "mock-model", inputTokens: 11, outputTokens: 7 },
    });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("CVE-2024-0001");
  });

  it("rejects answers that do not match the schema", async () => {
    const model = modelAnswering(JSON.stringify({ analysis: "x", confidence: 7 }));
    await expect(createLlmPatchGenerator(model).propose(request)).rejects.toThrow();
  });
});
