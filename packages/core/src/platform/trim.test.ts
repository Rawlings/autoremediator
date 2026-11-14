import { describe, expect, it } from "vitest";

import { trimChar } from "./trim.js";

describe("trimChar", () => {
  it("trims both sides by default", () => {
    expect(trimChar("--a-b--", "-")).toBe("a-b");
  });

  it("trims only the requested side", () => {
    expect(trimChar("//x//", "/", "end")).toBe("//x");
    expect(trimChar("//x//", "/", "start")).toBe("x//");
  });

  it("handles strings made only of the trim character", () => {
    expect(trimChar("-----", "-")).toBe("");
  });

  it("runs in linear time on adversarial input", () => {
    const hostile = `${"-".repeat(200_000)}x${"-".repeat(200_000)}!`;
    const started = performance.now();
    trimChar(hostile, "-");
    expect(performance.now() - started).toBeLessThan(500);
  });
});
