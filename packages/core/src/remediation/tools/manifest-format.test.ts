import { describe, expect, it } from "vitest";

import { serializeManifest } from "./manifest-format.js";

const value = { name: "a", dependencies: { b: "1.0.0" } };

describe("serializeManifest", () => {
  it("keeps two-space, four-space and tab indentation", () => {
    for (const indent of ["  ", "    ", "\t"]) {
      const original = `{\n${indent}"name": "a"\n}\n`;
      expect(serializeManifest(original, value)).toBe(JSON.stringify(value, null, indent) + "\n");
    }
  });

  it("keeps the final newline, or the lack of one, and CRLF line endings", () => {
    expect(serializeManifest('{\n  "a": 1\n}', value).endsWith("}")).toBe(true);
    expect(serializeManifest('{\n  "a": 1\n}\n', value).endsWith("}\n")).toBe(true);
    const crlf = serializeManifest('{\r\n  "a": 1\r\n}\r\n', value);
    expect(crlf).toContain("\r\n");
    expect(crlf.replaceAll("\r\n", "")).not.toContain("\n");
    expect(crlf.endsWith("}\r\n")).toBe(true);
  });

  it("falls back to two spaces when the original shows no indentation", () => {
    expect(serializeManifest('{"a":1}', value)).toBe(JSON.stringify(value, null, 2));
  });
});
