import { describe, expect, it } from "vitest";

import { isIgnoredPackage } from "./freshness-policy.js";
import { loadPolicy } from "./policy.js";

const load = (yaml: string) => loadPolicy(process.cwd(), `---\n${yaml}\n`);

describe("policy `freshness` key", () => {
  it("accepts every limit and the ignore list", () => {
    const policy = load(
      "freshness:\n  maxMajorsBehind: 1\n  maxMinorsBehind: 4\n  maxAgeDays: 365\n  ignore: [left-pad, '@types/*']",
    );
    expect(policy.freshness).toEqual({
      maxMajorsBehind: 1,
      maxMinorsBehind: 4,
      maxAgeDays: 365,
      ignore: ["left-pad", "@types/*"],
    });
  });

  it("defaults ignore to empty and keeps 0 as a real limit", () => {
    expect(load("freshness:\n  maxMajorsBehind: 0").freshness).toEqual({
      maxMajorsBehind: 0,
      ignore: [],
    });
  });

  it("is absent when the key is", () => {
    expect(load("allowMajorBumps: true").freshness).toBeUndefined();
  });

  it("rejects unknown keys, naming them", () => {
    expect(() => load("freshness:\n  maxMajorsBehind: 1\n  maxMajorBehind: 2")).toThrow(
      /freshness: unknown field\(s\) "maxMajorBehind"/,
    );
  });

  it("rejects a key that limits nothing", () => {
    expect(() => load("freshness:\n  ignore: [a]")).toThrow(/at least one of maxMajorsBehind/);
    expect(() => load("freshness: {}")).toThrow(/at least one of maxMajorsBehind/);
  });

  it("rejects negative, fractional and non-numeric limits", () => {
    expect(() => load("freshness:\n  maxMajorsBehind: -1")).toThrow(/freshness\.maxMajorsBehind/);
    expect(() => load("freshness:\n  maxMinorsBehind: 1.5")).toThrow(/freshness\.maxMinorsBehind/);
    expect(() => load("freshness:\n  maxAgeDays: 0")).toThrow(/freshness\.maxAgeDays/);
    expect(() => load("freshness:\n  maxMajorsBehind: one")).toThrow(/freshness\.maxMajorsBehind/);
  });

  it("rejects blank ignore entries", () => {
    expect(() => load("freshness:\n  maxMajorsBehind: 1\n  ignore: ['']")).toThrow(/freshness\.ignore/);
  });
});

describe("isIgnoredPackage", () => {
  it("matches exact names, scope globs and prefix globs, and nothing else", () => {
    const ignore = ["left-pad", "@types/*", "eslint-*"];
    expect(isIgnoredPackage(ignore, "left-pad")).toBe(true);
    expect(isIgnoredPackage(ignore, "@types/node")).toBe(true);
    expect(isIgnoredPackage(ignore, "eslint-plugin-x")).toBe(true);
    expect(isIgnoredPackage(ignore, "left-pad2")).toBe(false);
    expect(isIgnoredPackage(ignore, "@scope/types")).toBe(false);
    expect(isIgnoredPackage([], "anything")).toBe(false);
    expect(isIgnoredPackage(["*"], "anything")).toBe(true);
  });
});
