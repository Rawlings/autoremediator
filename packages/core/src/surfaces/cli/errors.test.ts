import { describe, expect, it } from "vitest";

import { formatCliError, wantsJson } from "./errors.js";

describe("wantsJson", () => {
  it("detects both flag spellings", () => {
    expect(wantsJson(["node", "cli", "--output-format", "json"])).toBe(true);
    expect(wantsJson(["node", "cli", "--output-format=json"])).toBe(true);
  });

  it("is false for text, sarif and no flag", () => {
    expect(wantsJson(["node", "cli"])).toBe(false);
    expect(wantsJson(["node", "cli", "--output-format", "sarif"])).toBe(false);
    expect(wantsJson(["node", "cli", "--output-format"])).toBe(false);
  });
});

describe("formatCliError", () => {
  it("keeps the prefixed text form by default", () => {
    expect(formatCliError(new Error("boom"), false)).toBe("[autoremediator] boom\n");
  });

  it("writes one parseable JSON line when asked", () => {
    const line = formatCliError(new TypeError("bad input"), true);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ error: { name: "TypeError", message: "bad input" } });
  });

  it("handles thrown non-errors", () => {
    expect(JSON.parse(formatCliError("plain", true))).toEqual({
      error: { name: "Error", message: "plain" },
    });
  });
});
