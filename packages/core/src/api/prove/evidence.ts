/**
 * The evidence record that goes next to a kept reproduction script, its optional signature, and
 * the reading side (verify a signature, list evidence for the VEX output).
 *
 * Files, under the project's patches directory (the same place the proof-of-fix check looks):
 *   <name>+<vulnerable-version>.test.cjs     the script
 *   <name>+<vulnerable-version>.proof.json   the evidence record
 *   <name>+<vulnerable-version>.proof.json.sig   optional detached signature
 *
 * The signature is DSSE (https://github.com/secure-systems-lab/dsse): Ed25519 over the
 * pre-authentication encoding of the payload type and the exact bytes of the record file. It is
 * detached, so the record stays plain JSON a person can read and diff. Keys are local PEM files; there is no
 * key service and no certificate: whoever holds the public key checks that the record was
 * signed by the matching private key and has not changed since.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { SandboxReport } from "../../platform/sandbox.js";
import type { JudgedRun } from "./types.js";

export const PAYLOAD_TYPE = "application/vnd.autoremediator.proof-of-fix+json";
export const EVIDENCE_SUFFIX = ".proof.json";
export const SIGNATURE_SUFFIX = ".sig";

export interface ProofEvidence {
  schemaVersion: "1.0";
  kind: "proof-of-fix-evidence";
  advisoryId: string;
  /** Other ids the advisory source gave the same record (for example the GHSA id of a CVE). */
  aliases?: string[];
  package: string;
  vulnerableVersion: string;
  fixedVersion: string;
  /** What the harness established, and what it did not. */
  claim: string;
  script: {
    /** Relative to the project directory, with forward slashes. */
    path: string;
    sha256: string;
  };
  vulnerableRun: JudgedRun;
  fixedRun: JudgedRun;
  /** How many times the vulnerable/fixed pair held. */
  confirmedRuns: number;
  tarballs: {
    vulnerable: { url: string; integrity: string };
    fixed: { url: string; integrity: string };
  };
  sandbox: SandboxReport & { env: string[]; timeoutMs: number; maxOutputBytes: number };
  nodeVersion: string;
  timestamp: string;
  /** The model that proposed the script, or null when it was supplied. */
  model: string | null;
  /** The agent that proposed it (`builtin:<model>`, or the id of an injected agent). */
  agent: string;
  /** How many candidate scripts the harness judged, including the kept one. */
  trials: number;
}

export const CLAIM =
  "The script fails on the vulnerable version and passes on the fixed version, repeatably, in the sandbox described here. It shows the two versions behave differently through the package's public API; whether that difference is the advisory's vulnerability is for the reviewer of the script to confirm.";

const safeName = (name: string): string => name.replace(/^@/, "").replaceAll("/", "+");

/** `<name>+<version>` in the form the existing proof-of-fix lookup uses. */
export function baseName(packageName: string, vulnerableVersion: string): string {
  return `${safeName(packageName)}+${vulnerableVersion}`;
}

export const scriptFileName = (packageName: string, vulnerableVersion: string): string =>
  `${baseName(packageName, vulnerableVersion)}.test.cjs`;
export const evidenceFileName = (packageName: string, vulnerableVersion: string): string =>
  `${baseName(packageName, vulnerableVersion)}${EVIDENCE_SUFFIX}`;

export const toPosix = (path: string): string => path.split("\\").join("/");

export const relativeTo = (root: string, path: string): string =>
  toPosix(relative(resolve(root), resolve(path)));

/** DSSE pre-authentication encoding. */
export function pae(payloadType: string, payload: Uint8Array): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, "utf8"),
    type,
    Buffer.from(` ${payload.length} `, "utf8"),
    Buffer.from(payload),
  ]);
}

export interface DetachedSignature {
  payloadType: string;
  algorithm: "ed25519";
  /** `sha256:` and the hex digest of the public key's SPKI DER encoding. */
  keyid: string;
  /** Base64 signature. */
  sig: string;
}

function keyIdOf(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function loadSigningKey(path: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(path));
  } catch (cause) {
    throw new Error(
      `Could not read an Ed25519 private key (PEM) from "${path}". Create one with: openssl genpkey -algorithm ed25519 -out key.pem`,
      { cause },
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `The signing key at "${path}" is ${String(key.asymmetricKeyType)}, not Ed25519. Create one with: openssl genpkey -algorithm ed25519 -out key.pem`,
    );
  }
  return key;
}

/** Sign the exact bytes of an evidence record. */
export function signRecord(record: Uint8Array, privateKey: KeyObject): DetachedSignature {
  const signature = cryptoSign(null, pae(PAYLOAD_TYPE, record), privateKey);
  return {
    payloadType: PAYLOAD_TYPE,
    algorithm: "ed25519",
    keyid: keyIdOf(createPublicKey(privateKey)),
    sig: signature.toString("base64"),
  };
}

export interface SignatureCheck {
  valid: boolean;
  keyid?: string;
  reason?: string;
}

/**
 * Check a detached signature over the record's bytes. `keyPath` is a PEM public key, or the
 * private key it belongs to.
 */
export function verifyRecordSignature(
  record: Uint8Array,
  signatureJson: string,
  keyPath: string,
): SignatureCheck {
  let signature: DetachedSignature;
  try {
    signature = JSON.parse(signatureJson) as DetachedSignature;
  } catch {
    return { valid: false, reason: "the signature file is not JSON" };
  }
  if (typeof signature !== "object" || signature === null) {
    return {
      valid: false,
      reason: "the signature file is not an autoremediator proof-of-fix signature",
    };
  }
  if (
    signature.payloadType !== PAYLOAD_TYPE ||
    signature.algorithm !== "ed25519" ||
    typeof signature.sig !== "string"
  ) {
    return {
      valid: false,
      reason: "the signature file is not an autoremediator proof-of-fix signature",
    };
  }
  let publicKey: KeyObject;
  try {
    const pem = readFileSync(keyPath);
    publicKey = pem.includes("PRIVATE KEY")
      ? createPublicKey(createPrivateKey(pem))
      : createPublicKey(pem);
  } catch {
    return { valid: false, reason: `could not read a PEM key from "${keyPath}"` };
  }
  const keyid = keyIdOf(publicKey);
  if (keyid !== signature.keyid) {
    return { valid: false, keyid, reason: "the signature was made with a different key" };
  }
  const ok = cryptoVerify(
    null,
    pae(PAYLOAD_TYPE, record),
    publicKey,
    Buffer.from(signature.sig, "base64"),
  );
  return ok
    ? { valid: true, keyid }
    : { valid: false, keyid, reason: "the signature does not match the record" };
}

/** An evidence record found on disk. */
export interface FoundEvidence {
  recordPath: string;
  record: ProofEvidence;
  signaturePath?: string;
  /** The script file exists and still has the hash the record names. */
  scriptCurrent: boolean;
}

const isEvidence = (value: unknown): value is ProofEvidence => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ProofEvidence>;
  return (
    candidate.kind === "proof-of-fix-evidence" &&
    candidate.schemaVersion === "1.0" &&
    typeof candidate.advisoryId === "string" &&
    typeof candidate.package === "string" &&
    typeof candidate.vulnerableVersion === "string" &&
    typeof candidate.fixedVersion === "string" &&
    (candidate.aliases === undefined ||
      (Array.isArray(candidate.aliases) &&
        candidate.aliases.every((alias) => typeof alias === "string"))) &&
    typeof candidate.script?.path === "string" &&
    typeof candidate.script.sha256 === "string"
  );
};

/** Evidence records in a patches directory. Unreadable or foreign JSON files are skipped. */
export function findEvidence(cwd: string, patchesDir: string): FoundEvidence[] {
  const dir = resolve(cwd, patchesDir);
  if (!existsSync(dir)) return [];
  const found: FoundEvidence[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(EVIDENCE_SUFFIX)) continue;
    const recordPath = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(recordPath, "utf8"));
    } catch {
      continue;
    }
    if (!isEvidence(parsed)) continue;
    const scriptPath = resolve(cwd, parsed.script.path);
    let scriptCurrent = false;
    try {
      scriptCurrent =
        createHash("sha256").update(readFileSync(scriptPath)).digest("hex") ===
        parsed.script.sha256;
    } catch {
      scriptCurrent = false;
    }
    const signaturePath = `${recordPath}${SIGNATURE_SUFFIX}`;
    found.push({
      recordPath,
      record: parsed,
      ...(existsSync(signaturePath) ? { signaturePath } : {}),
      scriptCurrent,
    });
  }
  return found;
}

/** Verify the signature of a record on disk against a public (or private) PEM key. */
export function verifyProofEvidence(recordPath: string, keyPath: string): SignatureCheck {
  const signaturePath = `${recordPath}${SIGNATURE_SUFFIX}`;
  if (!existsSync(signaturePath)) return { valid: false, reason: "there is no signature file" };
  return verifyRecordSignature(
    readFileSync(recordPath),
    readFileSync(signaturePath, "utf8"),
    keyPath,
  );
}
