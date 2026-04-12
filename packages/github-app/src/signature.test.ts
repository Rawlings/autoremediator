import { describe, expect, it } from "vitest";
import { computeWebhookSignature, verifyWebhookSignature } from "./signature.js";

describe("verifyWebhookSignature", () => {
  const secret = "test-secret";
  const payload = JSON.stringify({ hello: "world" });

  it("accepts a valid signature", () => {
    const signature = computeWebhookSignature(secret, payload);
    expect(verifyWebhookSignature(secret, payload, signature)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const signature = computeWebhookSignature(secret, payload).replace(/.$/, "0");
    expect(verifyWebhookSignature(secret, payload, signature)).toBe(false);
  });

  it("rejects missing signatures", () => {
    expect(verifyWebhookSignature(secret, payload, undefined)).toBe(false);
  });
});
