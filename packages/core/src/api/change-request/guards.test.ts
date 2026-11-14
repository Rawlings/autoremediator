import { describe, expect, it } from "vitest";

import { assertChangeRequestAllowed, stripUntrustedChangeRequestFields } from "./index.js";

describe("assertChangeRequestAllowed", () => {
  it("rejects change requests combined with dryRun or preview", () => {
    expect(() =>
      assertChangeRequestAllowed({ dryRun: true, changeRequest: { enabled: true } }),
    ).toThrow(/dryRun\/preview/);
    expect(() =>
      assertChangeRequestAllowed({ preview: true, changeRequest: { enabled: true } }),
    ).toThrow(/dryRun\/preview/);
  });

  it("allows real runs and dry runs without change requests", () => {
    expect(() => assertChangeRequestAllowed({ changeRequest: { enabled: true } })).not.toThrow();
    expect(() => assertChangeRequestAllowed({ dryRun: true })).not.toThrow();
    expect(() =>
      assertChangeRequestAllowed({ dryRun: true, changeRequest: { enabled: false } }),
    ).not.toThrow();
  });
});

describe("stripUntrustedChangeRequestFields", () => {
  it("removes token-redirecting fields but keeps the rest", () => {
    const out = stripUntrustedChangeRequestFields({
      cwd: "/repo",
      changeRequest: {
        enabled: true,
        repository: "o/r",
        tokenEnvVar: "SERVER_SECRET",
        githubApiUrl: "https://evil.example",
      },
    });
    expect(out).toEqual({ cwd: "/repo", changeRequest: { enabled: true, repository: "o/r" } });
  });

  it("walks arrays and nested objects such as portfolio targets", () => {
    const out = stripUntrustedChangeRequestFields({
      targets: [{ path: "a", options: { changeRequest: { tokenEnvVar: "X", enabled: true } } }],
    });
    expect(out).toEqual({
      targets: [{ path: "a", options: { changeRequest: { enabled: true } } }],
    });
  });

  it("does not mutate its input and passes primitives through", () => {
    const input = { changeRequest: { tokenEnvVar: "X" } };
    stripUntrustedChangeRequestFields(input);
    expect(input.changeRequest.tokenEnvVar).toBe("X");
    expect(stripUntrustedChangeRequestFields("x")).toBe("x");
    expect(stripUntrustedChangeRequestFields(null)).toBeNull();
  });
});
