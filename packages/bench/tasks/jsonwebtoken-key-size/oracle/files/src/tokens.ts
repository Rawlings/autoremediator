import { generateKeyPairSync } from "node:crypto";

import jwt from "jsonwebtoken";

export interface SigningKeys {
  privateKey: string;
  publicKey: string;
}

/** Ephemeral RS256 keys for local development. */
export function createDevKeys(): SigningKeys {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey, publicKey };
}

export function issue(subject: string, keys: SigningKeys): string {
  return jwt.sign({ sub: subject }, keys.privateKey, { algorithm: "RS256", expiresIn: "1h" });
}

export function subjectOf(token: string, keys: SigningKeys): string {
  const payload = jwt.verify(token, keys.publicKey, { algorithms: ["RS256"] });
  return typeof payload === "string" ? payload : String(payload.sub);
}
