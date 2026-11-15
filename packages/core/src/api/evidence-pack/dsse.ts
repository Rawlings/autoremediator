import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";

/** Payload type of an in-toto statement inside a DSSE envelope. */
export const INTOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/**
 * DSSE pre-authentication encoding (DSSE protocol, "Signature Protocol"):
 * `"DSSEv1" SP LEN(type) SP type SP LEN(body) SP body`, where SP is one ASCII space and LEN is the
 * length in bytes as ASCII decimal with no leading zeros. Lengths count UTF-8 bytes, not characters.
 */
export function pae(payloadType: string, body: string | Uint8Array): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, "ascii"),
    type,
    Buffer.from(` ${payload.length} `, "ascii"),
    payload,
  ]);
}

export interface DsseSignature {
  keyid?: string;
  /** Base64 of the signature over PAE(payloadType, payload). */
  sig: string;
}

export interface DsseEnvelope {
  payloadType: string;
  /** Base64 of the serialized body. */
  payload: string;
  signatures: DsseSignature[];
}

export type SigningAlgorithm = "ed25519" | "ecdsa-p256-sha256" | "ecdsa-p384-sha384";

export interface SigningKey {
  privateKey: KeyObject;
  algorithm: SigningAlgorithm;
  /** SHA-256 of the public key's SubjectPublicKeyInfo DER, hex. An unauthenticated hint, never a trust decision. */
  keyid: string;
  publicKeyPem: string;
}

/** SHA-256 over the SPKI DER of a public key, hex. */
export function keyIdOf(publicKey: KeyObject): string {
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

function algorithmOf(key: KeyObject): SigningAlgorithm {
  if (key.asymmetricKeyType === "ed25519") return "ed25519";
  if (key.asymmetricKeyType === "ec") {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve === "prime256v1" || curve === "P-256") return "ecdsa-p256-sha256";
    if (curve === "secp384r1" || curve === "P-384") return "ecdsa-p384-sha384";
    throw new Error(`Unsupported ECDSA curve ${String(curve)}; use P-256 or P-384.`);
  }
  throw new Error(
    `Unsupported key type ${String(key.asymmetricKeyType)}; use an Ed25519 or ECDSA (P-256, P-384) key.`,
  );
}

const HASH_OF: Record<SigningAlgorithm, string | null> = {
  ed25519: null,
  "ecdsa-p256-sha256": "sha256",
  "ecdsa-p384-sha384": "sha384",
};

/** Read an unencrypted PEM private key (PKCS#8 or SEC1). Never logs or returns the key material. */
export function loadSigningKey(path: string): SigningKey {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read the signing key at "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch (error) {
    throw new Error(
      `The signing key at "${path}" is not a usable unencrypted PEM private key (PKCS#8 or SEC1). Generate one with: openssl genpkey -algorithm ed25519 -out evidence-signing.pem`,
      { cause: error },
    );
  }
  const algorithm = algorithmOf(privateKey);
  const publicKey = createPublicKey(privateKey);
  return {
    privateKey,
    algorithm,
    keyid: keyIdOf(publicKey),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

/** Read a PEM public key for verification. */
export function loadPublicKey(path: string): KeyObject {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read the public key at "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    const key = createPublicKey(pem);
    algorithmOf(key);
    return key;
  } catch (error) {
    throw new Error(
      `The file at "${path}" is not a usable PEM public key (Ed25519 or ECDSA P-256/P-384): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Sign `PAE(payloadType, body)`. ECDSA signatures are DER encoded, as Sigstore tooling expects. */
export function signPayload(
  key: SigningKey,
  payloadType: string,
  body: string | Uint8Array,
): DsseSignature {
  const signature = cryptoSign(HASH_OF[key.algorithm], pae(payloadType, body), key.privateKey);
  return { keyid: key.keyid, sig: signature.toString("base64") };
}

/** A DSSE envelope around `body`; unsigned (`signatures: []`) when no key is given. */
export function createEnvelope(
  body: string,
  key: SigningKey | undefined,
  payloadType: string = INTOTO_PAYLOAD_TYPE,
): DsseEnvelope {
  return {
    payloadType,
    payload: Buffer.from(body, "utf8").toString("base64"),
    signatures: key ? [signPayload(key, payloadType, body)] : [],
  };
}

/** Decode base64 in either the standard or the URL-safe alphabet; the DSSE protocol allows both. */
export function decodeBase64(text: string): Buffer {
  return Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

export type EnvelopeCheck = { ok: true; keyid: string } | { ok: false; reason: string };

/**
 * Check that at least one signature of the envelope verifies against `publicKey` over the PAE of
 * the envelope's own payload type and payload. The `keyid` is not used to decide anything.
 */
export function verifyEnvelope(envelope: DsseEnvelope, publicKey: KeyObject): EnvelopeCheck {
  if (
    typeof envelope?.payloadType !== "string" ||
    typeof envelope.payload !== "string" ||
    !Array.isArray(envelope.signatures)
  ) {
    return { ok: false, reason: "not a DSSE envelope" };
  }
  if (envelope.signatures.length === 0) return { ok: false, reason: "the envelope is not signed" };
  const algorithm = algorithmOf(publicKey);
  const data = pae(envelope.payloadType, decodeBase64(envelope.payload));
  for (const entry of envelope.signatures) {
    if (typeof entry?.sig !== "string") continue;
    try {
      if (cryptoVerify(HASH_OF[algorithm], data, publicKey, decodeBase64(entry.sig))) {
        return { ok: true, keyid: keyIdOf(publicKey) };
      }
    } catch {
      // A malformed signature is a failed one.
    }
  }
  return { ok: false, reason: "no signature verifies against the key" };
}
