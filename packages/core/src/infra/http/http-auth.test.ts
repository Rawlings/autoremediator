import { describe, expect, it } from "vitest";

import { getRoleForToken } from "./http-auth.js";

describe("static token lookup", () => {
  const configured = "admin:s3cret-token,reader:read-only-token";

  it("returns the role of the matching token", () => {
    expect(getRoleForToken("s3cret-token", configured, undefined)).toBe("admin");
    expect(getRoleForToken("read-only-token", configured, undefined)).toBe("reader");
  });

  it("refuses a token that is a prefix or an extension of a configured one", () => {
    expect(getRoleForToken("s3cret", configured, undefined)).toBeUndefined();
    expect(getRoleForToken("s3cret-token-and-more", configured, undefined)).toBeUndefined();
  });

  it("refuses a token that differs only by trailing zero bytes", () => {
    expect(getRoleForToken("s3cret-token\0", configured, undefined)).toBeUndefined();
  });

  it("handles tokens longer than the comparison block", () => {
    const long = "x".repeat(2000);
    expect(getRoleForToken(long, `operator:${long}`, undefined)).toBe("operator");
    expect(getRoleForToken(`${long}y`, `operator:${long}`, undefined)).toBeUndefined();
  });

  it("never matches an empty secret", () => {
    expect(getRoleForToken("", "admin:", undefined)).toBeUndefined();
  });

  it("is development mode, with every request an admin, when nothing is configured", () => {
    expect(getRoleForToken("anything", undefined, undefined)).toBe("admin");
  });
});
