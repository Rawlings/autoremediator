import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

export function computeWebhookSignature(secret: string, payload: string): string {
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  return `${PREFIX}${digest}`;
}

export function verifyWebhookSignature(secret: string, payload: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(PREFIX)) {
    return false;
  }

  const expected = Buffer.from(computeWebhookSignature(secret, payload));
  const actual = Buffer.from(signatureHeader);

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
