import { describe, expect, it } from "vitest";

import { redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("hides a git auth header on a failed command line", () => {
    const text =
      "Command failed with exit code 1: git -c 'http.extraheader=AUTHORIZATION: basic c2VjcmV0' push origin x";
    const out = redactSecrets(text);
    expect(out).not.toContain("c2VjcmV0");
    expect(out).toContain("AUTHORIZATION: basic ***");
    expect(out).toContain("push origin x");
  });

  it("hides bearer headers regardless of case, and credentials in URLs", () => {
    expect(redactSecrets("authorization: Bearer abc.def.ghi")).toBe("authorization: Bearer ***");
    expect(redactSecrets("clone https://x-access-token:ghs_secret@github.com/o/r.git failed")).toBe(
      "clone https://***@github.com/o/r.git failed",
    );
  });

  it("hides recognisable tokens and private keys wherever they appear", () => {
    const text = [
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "aws AKIAABCDEFGHIJKLMNOP",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redactSecrets(text, {});
    expect(out).not.toMatch(/ghp_|sk-ant|AKIA|MIIEvQ/);
    expect(out).toContain("token ***");
  });

  it("hides the value of a secret environment variable, even in a format it does not know", () => {
    const env = { MY_SERVICE_PASSWORD: "correct-horse-battery", PATH: "/usr/bin" };
    const out = redactSecrets("db said correct-horse-battery was wrong; PATH=/usr/bin", env);
    expect(out).toBe("db said *** was wrong; PATH=/usr/bin");
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("push rejected (non-fast-forward)")).toBe(
      "push rejected (non-fast-forward)",
    );
  });
});
