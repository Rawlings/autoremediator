import { describe, expect, it, vi } from "vitest";
import { parseModelSpec, resolveLanguageModel } from "./model.js";

describe("parseModelSpec", () => {
  it("splits provider and model id on the first colon", () => {
    expect(parseModelSpec("anthropic:claude-sonnet-5-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5-5",
    });
    expect(parseModelSpec("openai:ft:gpt:org::id")).toEqual({
      provider: "openai",
      modelId: "ft:gpt:org::id",
    });
  });

  it.each(["", "anthropic", ":model", "anthropic:", "Anthropic:x", "../evil:x", "@scope/pkg:x"])(
    "rejects %j",
    (spec) => {
      expect(() => parseModelSpec(spec)).toThrow(/Invalid model/);
    },
  );
});

describe("resolveLanguageModel", () => {
  it("loads @ai-sdk/<provider> and builds the model from its same-named export", async () => {
    const createModel = vi.fn((id: string) => ({ modelId: id }));
    const load = vi.fn().mockResolvedValue({ acme: createModel });

    const model = await resolveLanguageModel("acme:fast-1", load);

    expect(load).toHaveBeenCalledWith("@ai-sdk/acme");
    expect(createModel).toHaveBeenCalledWith("fast-1");
    expect(model).toEqual({ modelId: "fast-1" });
  });

  it("explains how to fix a missing provider package", async () => {
    const load = vi.fn().mockRejectedValue(new Error("Cannot find package"));
    await expect(resolveLanguageModel("acme:fast-1", load)).rejects.toThrow(
      /requires the @ai-sdk\/acme package/,
    );
  });

  it("fails clearly when the package has no matching provider export", async () => {
    const load = vi.fn().mockResolvedValue({ other: () => ({}) });
    await expect(resolveLanguageModel("acme:fast-1", load)).rejects.toThrow(
      /does not export a "acme" provider/,
    );
  });

  it("never imports anything outside the @ai-sdk scope", async () => {
    const load = vi.fn();
    await expect(resolveLanguageModel("../../etc/passwd:x", load)).rejects.toThrow(/Invalid model/);
    expect(load).not.toHaveBeenCalled();
  });
});
