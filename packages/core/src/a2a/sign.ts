/**
 * Agent Card signing (A2A 1.0 section 8.4): a JWS (RFC 7515) over the card canonicalized with the
 * JSON Canonicalization Scheme (RFC 8785), `signatures` excluded. node:crypto only.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";

import type { AgentCard, AgentCardSignature } from "./agent-card.js";

export type JwsAlgorithm = "ES256" | "ES384" | "ES512" | "EdDSA";

export interface SigningKey {
  privateKey: KeyObject;
  alg: JwsAlgorithm;
  /** RFC 7638 JWK thumbprint of the public key. */
  kid: string;
}

const EC_CURVES: Record<string, { alg: JwsAlgorithm; hash: string }> = {
  prime256v1: { alg: "ES256", hash: "sha256" },
  secp384r1: { alg: "ES384", hash: "sha384" },
  secp521r1: { alg: "ES512", hash: "sha512" },
};

/** RFC 8785: members sorted by UTF-16 code unit, no whitespace, ES6 number and string forms. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item === undefined ? null : item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new Error(`Cannot canonicalize a value of type ${typeof value}`);
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

/** RFC 7638 thumbprint: SHA-256 over the required JWK members in lexicographic order. */
function thumbprint(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" });
  const members =
    jwk.kty === "EC"
      ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
      : { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  return createHash("sha256").update(canonicalize(members)).digest("base64url");
}

function algorithmFor(key: KeyObject): { alg: JwsAlgorithm; hash: string | null } {
  if (key.asymmetricKeyType === "ed25519") return { alg: "EdDSA", hash: null };
  if (key.asymmetricKeyType === "ec") {
    const curve = EC_CURVES[key.asymmetricKeyDetails?.namedCurve ?? ""];
    if (curve) return curve;
  }
  throw new Error("Signing key must be an EC key (P-256, P-384 or P-521) or an Ed25519 key");
}

/** Parse a PEM private key (EC P-256/384/521 or Ed25519) into a signing key. */
export function signingKeyFromPem(pem: string): SigningKey {
  const privateKey = createPrivateKey(pem);
  const { alg } = algorithmFor(privateKey);
  return { privateKey, alg, kid: thumbprint(createPublicKey(privateKey)) };
}

const keyCache = new Map<string, SigningKey>();

/**
 * The signing key named by `AUTOREMEDIATOR_A2A_SIGNING_KEY` (a path to a PEM private key), or
 * undefined when it is unset. A set but unusable key throws: a card that should be signed is never
 * served unsigned.
 */
export function signingKeyFromEnv(env: NodeJS.ProcessEnv = process.env): SigningKey | undefined {
  const path = env["AUTOREMEDIATOR_A2A_SIGNING_KEY"];
  if (!path) return undefined;
  const cached = keyCache.get(path);
  if (cached) return cached;
  let key: SigningKey;
  try {
    key = signingKeyFromPem(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `AUTOREMEDIATOR_A2A_SIGNING_KEY could not be used: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  keyCache.set(path, key);
  return key;
}

function withoutSignatures(card: AgentCard): Omit<AgentCard, "signatures"> {
  const { signatures: _signatures, ...rest } = card;
  return rest;
}

function signingInput(protectedHeader: string, card: AgentCard): Buffer {
  const payload = base64url(canonicalize(withoutSignatures(card)));
  return Buffer.from(`${protectedHeader}.${payload}`, "ascii");
}

/** Return the card with one JWS signature appended to `signatures`. */
export function signAgentCard(card: AgentCard, key: SigningKey): AgentCard {
  const { hash } = algorithmFor(key.privateKey);
  const protectedHeader = base64url(JSON.stringify({ alg: key.alg, typ: "JOSE", kid: key.kid }));
  const input = signingInput(protectedHeader, card);
  const signature =
    hash === null
      ? cryptoSign(null, input, key.privateKey)
      : cryptoSign(hash, input, { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  const entry: AgentCardSignature = { protected: protectedHeader, signature: base64url(signature) };
  return { ...card, signatures: [...(card.signatures ?? []), entry] };
}

/** True when at least one signature on the card verifies with `publicKey`. */
export function verifyAgentCard(card: AgentCard, publicKey: KeyObject): boolean {
  return (card.signatures ?? []).some((entry) => {
    try {
      const header = JSON.parse(Buffer.from(entry.protected, "base64url").toString("utf8")) as {
        alg?: string;
        kid?: string;
      };
      const { alg, hash } = algorithmFor(publicKey);
      if (header.alg !== alg || header.kid !== thumbprint(publicKey)) return false;
      const input = signingInput(entry.protected, card);
      const signature = Buffer.from(entry.signature, "base64url");
      return hash === null
        ? cryptoVerify(null, input, publicKey, signature)
        : cryptoVerify(hash, input, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
    } catch {
      return false;
    }
  });
}
