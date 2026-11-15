import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { loadPolicy } from "../../platform/policy.js";
import type { SbomEntry } from "../../platform/types.js";
import { fingerprintRepo } from "../../runs/fingerprint.js";
import { sha256 } from "../../runs/hash.js";
import { isRunId } from "../../runs/ids.js";
import { RunStore } from "../../runs/run-store.js";
import { PACKAGE_VERSION } from "../../version.js";
import { loadProjectLocks } from "../incident/project.js";
import {
  PACK_PREDICATE_TYPE,
  STATEMENT_TYPE,
  buildRunStatement,
  projectSubjects,
  type Statement,
} from "./attest.js";
import { factKey } from "./components.js";
import { buildCraDraft, parseAwareness } from "./cra.js";
import {
  createEnvelope,
  decodeBase64,
  loadPublicKey,
  loadSigningKey,
  verifyEnvelope,
  type DsseEnvelope,
  type SigningKey,
} from "./dsse.js";
import { collectFindings, type VexStatus } from "./findings.js";
import { renderReadme } from "./readme.js";
import { buildSbom, productIdentity } from "./sbom.js";
import type { EvidencePackFile, EvidencePackResult } from "./types.js";
import { buildCycloneDxVex, buildOpenVex } from "./vex.js";

export { craDeadlines, parseAwareness } from "./cra.js";
export type { CraDeadlines } from "./cra.js";
export type { EvidencePackFile, EvidencePackResult } from "./types.js";
export { INTOTO_PAYLOAD_TYPE, pae } from "./dsse.js";
export type { DsseEnvelope } from "./dsse.js";
export { PACK_PREDICATE_TYPE, RUN_PREDICATE_TYPE } from "./attest.js";

/** Environment variable naming a PEM private key file to sign attestations with (CLI and SDK only). */
export const SIGNING_KEY_ENV = "AUTOREMEDIATOR_EVIDENCE_SIGNING_KEY";

export const EVIDENCE_PACK_DISCLAIMER =
  "Evidence assembled by autoremediator from files on this machine. It is not legal advice, not a conformity assessment and not a claim that any product complies with Regulation (EU) 2024/2847. The statements in it have not been reviewed by a person.";

export interface EvidencePackOptions {
  /** Project directory (default: process.cwd()). */
  cwd?: string;
  /** Directory to write the pack into. Must be empty, absent, or hold an earlier pack. */
  outDir: string;
  /** Recorded runs to include (default: every run under `.autoremediator/runs/`). */
  runIds?: string[];
  /** Policy file whose suppressions become VEX statements (default: `.github/autoremediator.yml`). */
  policy?: string;
  /** Product name (default: `name` from package.json). */
  productName?: string;
  /** Product version (default: `version` from package.json). */
  productVersion?: string;
  /** Manufacturer name, written into the SBOM metadata, the OpenVEX author and the CRA drafts. */
  manufacturer?: string;
  /** OpenVEX document author (default: a marked, unreviewed draft). */
  author?: string;
  /** When the manufacturer became aware of exploitation, ISO 8601 with a time zone. Starts the Article 14 clocks. */
  awarenessAt?: string;
  /** Awareness per advisory id, for when it differs; overrides `awarenessAt`. */
  awarenessByCve?: Record<string, string>;
  /** When a corrective or mitigating measure became available to users, ISO 8601 with a time zone. */
  correctiveMeasureAt?: string;
  /** PEM private key file (Ed25519, ECDSA P-256 or P-384). Without one the attestations are unsigned. */
  signingKeyPath?: string;
  /** Which surface the call arrived on. The environment key is only honored for the CLI and SDK. */
  source?: "cli" | "sdk" | "mcp" | "openapi" | "unknown";
}

export interface EvidencePackDeps {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

const PACK_STATEMENT_FILES = ["attestations/pack.intoto.json", "attestations/pack.statement.json"];

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Remove what an earlier pack wrote, so a regenerated pack never mixes old and new files. */
function clearEarlierPack(outDir: string): void {
  const notAPack = (why: string): Error =>
    new Error(
      `outDir "${outDir}" is not empty and its manifest.json is not an autoremediator evidence pack manifest (${why}). Nothing was removed. Choose an empty or new directory.`,
    );
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
  } catch {
    throw notAPack("it is not JSON");
  }
  if (!record(manifest)) throw notAPack("it is not an object");
  const generator = manifest["generator"];
  if (
    manifest["schemaVersion"] !== "1" ||
    !record(generator) ||
    generator["name"] !== "autoremediator"
  ) {
    throw notAPack("it was not written by autoremediator");
  }
  const entries = manifest["files"];
  if (!Array.isArray(entries)) throw notAPack("it lists no files");

  // Only the files the manifest lists, by relative path inside outDir, with the digest it recorded.
  const root = resolve(outDir);
  const listed: Array<{ path: string; sha256: string }> = [];
  for (const entry of entries as unknown[]) {
    const path = record(entry) ? entry["path"] : undefined;
    const digest = record(entry) ? entry["sha256"] : undefined;
    if (typeof path !== "string" || typeof digest !== "string")
      throw notAPack("a file entry is malformed");
    const target = resolve(root, path);
    if (
      path === "" ||
      isAbsolute(path) ||
      path === "manifest.json" ||
      !target.startsWith(`${root}${sep}`)
    ) {
      throw notAPack(`it lists a path outside the pack: ${JSON.stringify(path)}`);
    }
    listed.push({ path, sha256: digest });
  }

  const changed = listed.flatMap(({ path, sha256: digest }) => {
    const full = join(outDir, path);
    return existsSync(full) && sha256(readFileSync(full, "utf8")) !== digest ? [path] : [];
  });
  if (changed.length > 0) {
    throw new Error(
      `outDir "${outDir}" holds an evidence pack whose files changed since the pack was written: ${changed.toSorted().join(", ")}. Nothing was removed. Move or restore them, or choose a new directory.`,
    );
  }

  const removed = [...listed.map(({ path }) => path), ...PACK_STATEMENT_FILES, "manifest.json"];
  const directories = new Set<string>();
  for (const path of removed) {
    rmSync(join(outDir, path), { force: true });
    for (let dir = dirname(path); dir !== "." && dir !== "/"; dir = dirname(dir))
      directories.add(dir);
  }
  // Remove only the directories the pack itself made, deepest first, and only when nothing else is in them.
  for (const dir of [...directories].toSorted((a, b) => b.length - a.length)) {
    const full = join(outDir, dir);
    if (existsSync(full) && readdirSync(full).length === 0) rmdirSync(full);
  }
}

function prepareOutDir(outDir: string): void {
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
    return;
  }
  if (!statSync(outDir).isDirectory())
    throw new Error(`outDir "${outDir}" exists and is not a directory.`);
  const entries = readdirSync(outDir);
  if (entries.length === 0) return;
  if (!entries.includes("manifest.json")) {
    throw new Error(
      `outDir "${outDir}" is not empty and does not hold an evidence pack (no manifest.json). Choose an empty or new directory.`,
    );
  }
  clearEarlierPack(outDir);
}

function resolveSigningKey(
  options: EvidencePackOptions,
  env: NodeJS.ProcessEnv,
): SigningKey | undefined {
  const fromOption = options.signingKeyPath;
  // Remote callers (MCP, HTTP) must name the key themselves, inside the allowed roots; the
  // operator's environment key is not theirs to use.
  const trustedCaller =
    options.source === undefined || options.source === "cli" || options.source === "sdk";
  const fromEnv = trustedCaller ? env[SIGNING_KEY_ENV] : undefined;
  const path = fromOption ?? (fromEnv && fromEnv.trim() !== "" ? fromEnv : undefined);
  return path ? loadSigningKey(resolve(options.cwd ?? process.cwd(), path)) : undefined;
}

/**
 * Assemble an evidence pack from what is on this machine: a CycloneDX 1.6 SBOM of the lockfile,
 * CycloneDX and OpenVEX statements from policy suppressions and recorded runs, Article 14
 * reporting drafts for CISA-KEV-listed advisories, and in-toto attestations of the recorded runs'
 * ledgers (signed only when a key is given), with a manifest of sha256 digests. Nothing is
 * fetched and nothing is submitted. Files are written only under `outDir`.
 */
export async function buildEvidencePack(
  options: EvidencePackOptions,
  deps: EvidencePackDeps = {},
): Promise<EvidencePackResult> {
  const now = (deps.now ?? (() => new Date()))();
  const cwd = resolve(options.cwd ?? process.cwd());
  const outDir = resolve(cwd, options.outDir);
  const env = deps.env ?? process.env;
  const notes: string[] = [];

  // Validate everything that can be refused before anything is written.
  const awareness = options.awarenessAt
    ? parseAwareness(options.awarenessAt, "awarenessAt")
    : undefined;
  const awarenessByCve = new Map<string, Date>();
  for (const [cveId, value] of Object.entries(options.awarenessByCve ?? {})) {
    awarenessByCve.set(cveId.toUpperCase(), parseAwareness(value, `awarenessByCve[${cveId}]`));
  }
  const correctiveMeasureAt = options.correctiveMeasureAt
    ? parseAwareness(options.correctiveMeasureAt, "correctiveMeasureAt")
    : undefined;
  const key = resolveSigningKey({ ...options, cwd }, env);
  const policy = loadPolicy(cwd, options.policy);

  const store = new RunStore(cwd);
  for (const runId of options.runIds ?? []) {
    if (!isRunId(runId) || !store.exists(runId)) throw new Error(`Run not found: ${runId}`);
  }
  const runs = options.runIds ? options.runIds.map((runId) => store.load(runId)) : store.list();
  if (runs.length === 0) {
    notes.push(
      "No recorded runs were found under .autoremediator/runs/, so the pack has no run attestations and no run-based VEX statements.",
    );
  }

  const product = productIdentity(cwd, {
    ...(options.productName ? { name: options.productName } : {}),
    ...(options.productVersion ? { version: options.productVersion } : {}),
    ...(options.manufacturer ? { manufacturer: options.manufacturer } : {}),
  });

  // Report SBOM entries: newest run wins per package version.
  const reportEntries = new Map<string, SbomEntry>();
  for (const run of runs.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    for (const entry of store.readReport(run.runId)?.sbom ?? []) {
      reportEntries.set(factKey(entry.name, entry.version), entry);
    }
  }

  const locks = loadProjectLocks(cwd);
  const sbom = buildSbom({ cwd, product, locks, reportEntries, toolVersion: PACKAGE_VERSION, now });
  notes.push(...sbom.notes);

  const found = collectFindings({
    store,
    runs,
    suppressions: policy.suppressions ?? [],
    locked: sbom.source === "report" ? undefined : sbom.locked,
  });
  notes.push(...found.notes);
  const byStatus: Record<VexStatus, number> = {
    fixed: 0,
    affected: 0,
    not_affected: 0,
    under_investigation: 0,
  };
  for (const finding of found.findings) byStatus[finding.status] += 1;

  const cdxVex = buildCycloneDxVex({
    findings: found.findings,
    cves: found.cves,
    product,
    toolVersion: PACKAGE_VERSION,
    now,
  });
  const openVex = buildOpenVex({
    findings: found.findings,
    product,
    ...((options.author ?? options.manufacturer)
      ? { author: (options.author ?? options.manufacturer)! }
      : {}),
    toolVersion: PACKAGE_VERSION,
    now,
  });

  // Article 14 drafts: advisories CISA lists as exploited that the product is not recorded as unaffected by.
  const craReports: EvidencePackResult["craReports"] = [];
  const drafts: Array<{ path: string; content: string }> = [];
  const kevCves = [...found.cves.entries()].filter(([, details]) => details?.kev?.knownExploited);
  for (const [cveId, details] of kevCves) {
    const relevant = found.findings.filter(
      (finding) =>
        finding.cveId.toUpperCase() === cveId.toUpperCase() && finding.status !== "not_affected",
    );
    if (relevant.length === 0) {
      notes.push(
        `${cveId} is in the CISA KEV catalog but no finding says it affects the product (not affected, or no component recorded); no draft was written.`,
      );
      continue;
    }
    const draft = buildCraDraft({
      cveId,
      details,
      findings: relevant,
      product,
      ...((awarenessByCve.get(cveId.toUpperCase()) ?? awareness)
        ? { awareness: (awarenessByCve.get(cveId.toUpperCase()) ?? awareness)! }
        : {}),
      ...(correctiveMeasureAt ? { correctiveMeasureAvailableAt: correctiveMeasureAt } : {}),
      generatedAt: now,
      toolVersion: PACKAGE_VERSION,
    });
    drafts.push({ path: `cra-reports/${draft.fileName}`, content: draft.markdown });
    craReports.push({
      cveId,
      file: `cra-reports/${draft.fileName}`,
      status: draft.status,
      ...(draft.deadlines ? { deadlines: draft.deadlines } : {}),
    });
  }
  for (const cveId of awarenessByCve.keys()) {
    if (!kevCves.some(([id]) => id.toUpperCase() === cveId)) {
      notes.push(
        `An awareness time was given for ${cveId}, but no recorded run lists it as known exploited, so it has no draft.`,
      );
    }
  }
  if (kevCves.length === 0) {
    notes.push(
      "No recorded run lists an advisory in the CISA KEV catalog, so there are no Article 14 drafts. KEV data comes only from earlier runs; nothing was looked up now.",
    );
  } else if (!awareness && awarenessByCve.size === 0) {
    notes.push(
      "No awareness time was given (--awareness-at), so the drafts state the 24 hour and 72 hour rules but no dates.",
    );
  }

  // Attestations.
  const subjects = projectSubjects(cwd);
  const currentFilesSha256 = (await fingerprintRepo(cwd, options.policy)).filesSha256;
  const contents = new Map<string, { content: string; kind: EvidencePackFile["kind"] }>();
  const attestations: EvidencePackResult["attestations"] = [];
  const skippedRuns: EvidencePackResult["skippedRuns"] = [];
  for (const run of runs.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const built = buildRunStatement({
      store,
      run,
      subjects,
      currentFilesSha256,
      toolVersion: PACKAGE_VERSION,
      now,
    });
    if (!built.ok) {
      skippedRuns.push({ runId: run.runId, reason: built.reason });
      continue;
    }
    const body = JSON.stringify(built.statement);
    const envelope = createEnvelope(body, key);
    const base = `attestations/run-${run.runId}`;
    contents.set(`${base}.intoto.json`, { content: jsonText(envelope), kind: "attestation" });
    contents.set(`${base}.statement.json`, { content: `${body}\n`, kind: "statement" });
    attestations.push({
      runId: run.runId,
      runStatus: run.status,
      envelope: `${base}.intoto.json`,
      statement: `${base}.statement.json`,
      signed: key !== undefined,
      ledgerHead: built.ledgerHead,
    });
  }
  for (const skipped of skippedRuns)
    notes.push(`Run ${skipped.runId} has no attestation: ${skipped.reason}.`);
  if (key) {
    contents.set("attestations/signing-public-key.pem", {
      content: key.publicKeyPem,
      kind: "public-key",
    });
  } else {
    notes.push(
      `The attestations are unsigned (signatures: []). Pass --signing-key <pem> or set ${SIGNING_KEY_ENV} to sign them.`,
    );
  }

  contents.set("sbom/sbom.cdx.json", { content: jsonText(sbom.bom), kind: "sbom" });
  contents.set("vex/vex.cdx.json", { content: jsonText(cdxVex), kind: "vex" });
  contents.set("vex/vex.openvex.json", { content: jsonText(openVex), kind: "vex" });
  for (const draft of drafts)
    contents.set(draft.path, { content: draft.content, kind: "cra-draft" });

  const result: EvidencePackResult = {
    schemaVersion: "1",
    outDir,
    generatedAt: now.toISOString(),
    disclaimer: EVIDENCE_PACK_DISCLAIMER,
    signed: key !== undefined,
    ...(key ? { signingKeyId: key.keyid, signingAlgorithm: key.algorithm } : {}),
    files: [],
    manifest: { path: "manifest.json", sha256: "", bytes: 0, kind: "manifest" },
    packAttestation: {
      envelope: PACK_STATEMENT_FILES[0]!,
      statement: PACK_STATEMENT_FILES[1]!,
      signed: key !== undefined,
      manifestSha256: "",
    },
    sbom: {
      file: "sbom/sbom.cdx.json",
      specVersion: "1.6",
      source: sbom.source,
      components: sbom.componentCount,
      withHash: sbom.withHash,
      withLicense: sbom.withLicense,
    },
    vex: {
      cycloneDxFile: "vex/vex.cdx.json",
      openVexFile: "vex/vex.openvex.json",
      statements: found.findings.length,
      byStatus,
    },
    craReports,
    attestations,
    skippedRuns,
    notes,
  };
  contents.set("README.md", { content: renderReadme(result, product), kind: "readme" });

  // Write, then hash exactly what was written.
  prepareOutDir(outDir);
  const write = (path: string, content: string): EvidencePackFile["bytes"] => {
    const full = join(outDir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
    return Buffer.byteLength(content, "utf8");
  };
  const files: EvidencePackFile[] = [...contents.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([path, { content, kind }]) => ({
      path,
      sha256: sha256(content),
      bytes: write(path, content),
      kind,
    }));

  const manifestText = jsonText({
    schemaVersion: "1",
    generator: { name: "autoremediator", version: PACKAGE_VERSION },
    generatedAt: result.generatedAt,
    disclaimer: EVIDENCE_PACK_DISCLAIMER,
    signed: result.signed,
    ...(key ? { signingKeyId: key.keyid, signingAlgorithm: key.algorithm } : {}),
    excludedFromManifest: PACK_STATEMENT_FILES,
    files: files.map(({ path, sha256: digest, bytes, kind }) => ({
      path,
      sha256: digest,
      bytes,
      kind,
    })),
  });
  const manifestBytes = write("manifest.json", manifestText);
  const manifestSha256 = sha256(manifestText);

  const packStatement: Statement = {
    _type: STATEMENT_TYPE,
    subject: [{ name: "manifest.json", digest: { sha256: manifestSha256 } }],
    predicateType: PACK_PREDICATE_TYPE,
    predicate: {
      generator: { name: "autoremediator", version: PACKAGE_VERSION },
      attestedAt: result.generatedAt,
      disclaimer: EVIDENCE_PACK_DISCLAIMER,
      files: files.length,
      runAttestations: attestations.map((entry) => ({
        runId: entry.runId,
        ledgerHead: entry.ledgerHead,
      })),
    },
  };
  const packBody = JSON.stringify(packStatement);
  write(PACK_STATEMENT_FILES[0]!, jsonText(createEnvelope(packBody, key)));
  write(PACK_STATEMENT_FILES[1]!, `${packBody}\n`);

  return {
    ...result,
    files,
    manifest: {
      path: "manifest.json",
      sha256: manifestSha256,
      bytes: manifestBytes,
      kind: "manifest",
    },
    packAttestation: { ...result.packAttestation, manifestSha256 },
  };
}

// ---------------------------------------------------------------------------
// Verifying a pack
// ---------------------------------------------------------------------------

export interface EvidencePackVerification {
  /** Every listed file matches its digest, nothing is missing or extra, and, with a key, every signature verifies. */
  ok: boolean;
  /** At least one attestation in the pack is signed. */
  signed: boolean;
  /** A public key was given and every signed attestation verified against it. */
  signaturesVerified: boolean;
  problems: string[];
  notes: string[];
}

function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    return statSync(join(dir, name)).isDirectory() ? listFiles(join(dir, name), rel) : [rel];
  });
}

/**
 * Check a pack against its own manifest: every file's sha256, no missing or unlisted files, and the
 * pack attestation's subject. With `publicKeyPath`, also verify every DSSE signature against that
 * key. The key included in the pack is not a trust anchor (whoever tampered with the pack could
 * replace it), so it is never used for verification.
 */
export function verifyEvidencePack(
  packDir: string,
  options: { publicKeyPath?: string } = {},
): EvidencePackVerification {
  const dir = resolve(packDir);
  const problems: string[] = [];
  const notes: string[] = [];
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      signed: false,
      signaturesVerified: false,
      problems: ["manifest.json is missing"],
      notes,
    };
  }
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as {
    files?: Array<{ path: unknown; sha256: unknown }>;
  };
  const listed = new Set<string>();
  for (const entry of manifest.files ?? []) {
    if (typeof entry.path !== "string" || entry.path.includes("..") || entry.path.startsWith("/")) {
      problems.push(`manifest lists an unsafe path: ${JSON.stringify(entry.path)}`);
      continue;
    }
    listed.add(entry.path);
    const full = join(dir, entry.path);
    if (!existsSync(full)) problems.push(`missing: ${entry.path}`);
    else if (sha256(readFileSync(full)) !== entry.sha256)
      problems.push(`changed: ${entry.path} no longer matches its sha256 in the manifest`);
  }
  for (const path of listFiles(dir)) {
    if (path === "manifest.json" || PACK_STATEMENT_FILES.includes(path) || listed.has(path))
      continue;
    problems.push(`unlisted: ${path} is not in the manifest`);
  }

  const manifestSha256 = sha256(manifestText);
  const publicKey = options.publicKeyPath
    ? loadPublicKey(resolve(options.publicKeyPath))
    : undefined;
  let signed = false;
  let allVerified = publicKey !== undefined;
  const envelopes = [...listed, ...PACK_STATEMENT_FILES].filter((path) =>
    path.endsWith(".intoto.json"),
  );
  for (const path of envelopes) {
    const full = join(dir, path);
    if (!existsSync(full)) {
      if (PACK_STATEMENT_FILES.includes(path)) problems.push(`missing: ${path}`);
      continue;
    }
    let envelope: DsseEnvelope;
    let statement: Statement;
    try {
      envelope = JSON.parse(readFileSync(full, "utf8")) as DsseEnvelope;
      statement = JSON.parse(decodeBase64(envelope.payload).toString("utf8")) as Statement;
    } catch {
      problems.push(`unreadable attestation: ${path}`);
      continue;
    }
    if (envelope.signatures.length > 0) signed = true;
    if (
      path === PACK_STATEMENT_FILES[0] &&
      statement.subject?.[0]?.digest?.sha256 !== manifestSha256
    ) {
      problems.push(`${path} attests to a different manifest than the one in the pack`);
    }
    if (publicKey) {
      const check = verifyEnvelope(envelope, publicKey);
      if (!check.ok) {
        allVerified = false;
        problems.push(`signature: ${path}: ${check.reason}`);
      }
    }
  }
  if (!publicKey) {
    notes.push(
      signed
        ? "The attestations are signed, but no --public-key was given, so no signature was checked. The key inside the pack is not a trust anchor."
        : "The attestations are unsigned: the digests above show the files are unchanged since the manifest was written, not who wrote it.",
    );
  } else if (!signed) {
    problems.push("a public key was given but the attestations are not signed");
    allVerified = false;
  }

  return {
    ok: problems.length === 0,
    signed,
    signaturesVerified: publicKey !== undefined && allVerified && signed,
    problems,
    notes,
  };
}
