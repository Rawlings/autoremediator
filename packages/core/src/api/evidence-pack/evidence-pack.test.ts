import { execFileSync } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CveDetails, PatchResult, RemediationReport } from "../../platform/types.js";
import type { VerificationResult } from "../../remediation/verify/types.js";
import { applyPlan, persistPlan, type RunDeps } from "../runs/index.js";
import { toCycloneDxVex } from "../vex/index.js";
import { hashFromIntegrity, licenseChoice, npmPurl } from "./components.js";
import { craDeadlines, parseAwareness } from "./cra.js";
import { createEnvelope, loadSigningKey, verifyEnvelope } from "./dsse.js";
import {
  buildEvidencePack,
  EVIDENCE_PACK_DISCLAIMER,
  INTOTO_PAYLOAD_TYPE,
  pae,
  SIGNING_KEY_ENV,
  verifyEvidencePack,
  type DsseEnvelope,
} from "./index.js";

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "schemas");
const readSchema = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(SCHEMAS, name), "utf8")) as Record<string, unknown>;

// ajv-formats ships CommonJS with a default export; under NodeNext the function is on `.default`.
const interop = (module: unknown): ((ajv: unknown) => void) =>
  ((module as { default?: unknown }).default ?? module) as (ajv: unknown) => void;
const addFormatsFn = interop(addFormats);

function cycloneDxValidator(): ValidateFunction {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormatsFn(ajv);
  ajv.addSchema(readSchema("spdx.schema.json"));
  ajv.addSchema(readSchema("jsf-0.82.schema.json"));
  return ajv.compile(readSchema("bom-1.6.schema.json"));
}

function openVexValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormatsFn(ajv);
  return ajv.compile(readSchema("openvex-0.2.0.schema.json"));
}

/** Passes when `document` validates; otherwise fails showing the first schema errors. */
function expectValid(validate: ValidateFunction, document: unknown): void {
  const valid = validate(document);
  expect(valid ? [] : (validate.errors ?? []).slice(0, 5)).toEqual([]);
}

// ---------------------------------------------------------------------------
// Pure pieces: PAE, deadlines, integrity, licenses
// ---------------------------------------------------------------------------

describe("DSSE pre-authentication encoding", () => {
  it("matches the example in the DSSE protocol specification", () => {
    expect(pae("http://example.com/HelloWorld", "hello world").toString("utf8")).toBe(
      "DSSEv1 29 http://example.com/HelloWorld 11 hello world",
    );
  });

  it("counts bytes, not characters, and keeps zero as 0", () => {
    // "é" is two bytes in UTF-8, and the body may be empty.
    expect(pae("é", "€").toString("utf8")).toBe("DSSEv1 2 é 3 €");
    expect(pae("t", "").toString("utf8")).toBe("DSSEv1 1 t 0 ");
    expect(pae("t", new Uint8Array([0xff, 0x00]))).toHaveLength("DSSEv1 1 t 2 ".length + 2);
  });
});

describe("DSSE signing", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsse-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const keyFile = (
    type: "ed25519" | "p256" | "p384" | "rsa",
  ): { path: string; publicKey: KeyObject } => {
    const pair =
      type === "ed25519"
        ? generateKeyPairSync("ed25519")
        : type === "rsa"
          ? generateKeyPairSync("rsa", { modulusLength: 2048 })
          : generateKeyPairSync("ec", { namedCurve: type === "p256" ? "prime256v1" : "secp384r1" });
    const path = join(dir, `${type}.pem`);
    writeFileSync(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
    return { path, publicKey: pair.publicKey };
  };

  it.each(["ed25519", "p256", "p384"] as const)(
    "round-trips with %s and rejects tampering",
    (type) => {
      const { path, publicKey } = keyFile(type);
      const key = loadSigningKey(path);
      const body = JSON.stringify({ hello: "world" });
      const envelope = createEnvelope(body, key);

      expect(envelope.payloadType).toBe(INTOTO_PAYLOAD_TYPE);
      expect(Buffer.from(envelope.payload, "base64").toString("utf8")).toBe(body);
      expect(verifyEnvelope(envelope, publicKey)).toMatchObject({ ok: true });

      // Independent check: build the PAE string by hand and verify with node:crypto directly.
      const bytes = Buffer.from(body, "utf8");
      const type16 = Buffer.byteLength(INTOTO_PAYLOAD_TYPE);
      const manual = Buffer.from(
        `DSSEv1 ${type16} ${INTOTO_PAYLOAD_TYPE} ${bytes.length} ${body}`,
        "utf8",
      );
      const hash = type === "ed25519" ? null : type === "p256" ? "sha256" : "sha384";
      expect(
        cryptoVerify(hash, manual, publicKey, Buffer.from(envelope.signatures[0]!.sig, "base64")),
      ).toBe(true);

      const tampered: DsseEnvelope = {
        ...envelope,
        payload: Buffer.from(JSON.stringify({ hello: "mars" })).toString("base64"),
      };
      expect(verifyEnvelope(tampered, publicKey)).toEqual({
        ok: false,
        reason: "no signature verifies against the key",
      });
      // The payload type is signed too.
      expect(verifyEnvelope({ ...envelope, payloadType: "text/plain" }, publicKey)).toMatchObject({
        ok: false,
      });
      // Another key does not verify it.
      expect(verifyEnvelope(envelope, generateKeyPairSync("ed25519").publicKey)).toMatchObject({
        ok: false,
      });
    },
  );

  it("builds an unsigned envelope with an empty signature list, and refuses to verify it", () => {
    const envelope = createEnvelope("{}", undefined);
    expect(envelope.signatures).toEqual([]);
    expect(verifyEnvelope(envelope, generateKeyPairSync("ed25519").publicKey)).toEqual({
      ok: false,
      reason: "the envelope is not signed",
    });
  });

  it("refuses unsupported or unreadable keys with an actionable message", () => {
    expect(() => loadSigningKey(keyFile("rsa").path)).toThrow(/Ed25519 or ECDSA/);
    writeFileSync(join(dir, "junk.pem"), "not a key");
    expect(() => loadSigningKey(join(dir, "junk.pem"))).toThrow(/unencrypted PEM private key/);
    expect(() => loadSigningKey(join(dir, "missing.pem"))).toThrow(/Cannot read the signing key/);
  });
});

describe("Article 14 deadline arithmetic", () => {
  it("adds 24 hours, 72 hours and 14 days to the instants it is given, in UTC", () => {
    const deadlines = craDeadlines(
      parseAwareness("2026-11-10T14:30:00Z"),
      parseAwareness("2026-11-12T09:00:00Z"),
    );
    expect(deadlines).toEqual({
      awarenessAt: "2026-11-10T14:30:00.000Z",
      earlyWarningDue: "2026-11-11T14:30:00.000Z",
      notificationDue: "2026-11-13T14:30:00.000Z",
      finalReportDue: "2026-11-26T09:00:00.000Z",
    });
  });

  it("honors a UTC offset in the input", () => {
    expect(craDeadlines(parseAwareness("2026-11-10T15:30:00+01:00")).earlyWarningDue).toBe(
      "2026-11-11T14:30:00.000Z",
    );
  });

  it("counts elapsed hours across a daylight saving change, not wall-clock days", () => {
    // Europe/Paris leaves summer time on 2026-10-25; 72 elapsed hours is 72 hours of UTC time.
    const deadlines = craDeadlines(parseAwareness("2026-10-23T22:00:00Z"));
    expect(deadlines.notificationDue).toBe("2026-10-26T22:00:00.000Z");
  });

  it("carries across month and year ends", () => {
    const deadlines = craDeadlines(
      parseAwareness("2026-12-31T23:30:00Z"),
      parseAwareness("2026-12-31T23:30:00Z"),
    );
    expect(deadlines.earlyWarningDue).toBe("2027-01-01T23:30:00.000Z");
    expect(deadlines.finalReportDue).toBe("2027-01-14T23:30:00.000Z");
  });

  it("omits the final report deadline until a corrective measure date is given", () => {
    expect(craDeadlines(parseAwareness("2026-11-10T14:30:00Z"))).not.toHaveProperty(
      "finalReportDue",
    );
  });

  it("refuses a time without a zone, and a date that does not exist", () => {
    expect(() => parseAwareness("2026-11-10T14:30:00")).toThrow(/time zone/);
    expect(() => parseAwareness("2026-11-10")).toThrow(/time zone/);
    expect(() => parseAwareness("yesterday")).toThrow(/ISO 8601/);
    expect(() => parseAwareness("2026-02-31T10:00:00Z")).toThrow(/not a real date/);
  });
});

describe("components", () => {
  it("builds purls with the scope percent-encoded", () => {
    expect(npmPurl("lodash", "4.17.21")).toBe("pkg:npm/lodash@4.17.21");
    expect(npmPurl("@babel/core", "7.0.0")).toBe("pkg:npm/%40babel/core@7.0.0");
    expect(npmPurl("a", "1.0.0-beta.1+build")).toBe("pkg:npm/a@1.0.0-beta.1%2Bbuild");
  });

  it("turns lockfile integrity into a CycloneDX hash and drops what does not decode", () => {
    const digest = createHash("sha512").update("x").digest();
    expect(hashFromIntegrity(`sha512-${digest.toString("base64")}`)).toEqual({
      alg: "SHA-512",
      content: digest.toString("hex"),
    });
    const sha1 = createHash("sha1").update("x").digest();
    expect(hashFromIntegrity(`sha1-${sha1.toString("base64")}`)?.alg).toBe("SHA-1");
    // The strongest of several wins.
    expect(
      hashFromIntegrity(`sha1-${sha1.toString("base64")} sha512-${digest.toString("base64")}`)?.alg,
    ).toBe("SHA-512");
    expect(hashFromIntegrity("sha512-AAAA")).toBeUndefined();
    expect(hashFromIntegrity("md5-AAAA")).toBeUndefined();
  });

  it("only claims an SPDX id or expression it recognizes", () => {
    expect(licenseChoice("MIT")).toEqual({ license: { id: "MIT" } });
    expect(licenseChoice("apache-2.0")).toEqual({ license: { id: "Apache-2.0" } });
    expect(licenseChoice("(MIT OR Apache-2.0)")).toEqual({ expression: "(MIT OR Apache-2.0)" });
    expect(licenseChoice("(MIT OR Mystery-1.0)")).toEqual({
      license: { name: "(MIT OR Mystery-1.0)" },
    });
    expect(licenseChoice("SEE LICENSE IN LICENSE.md")).toEqual({
      license: { name: "SEE LICENSE IN LICENSE.md" },
    });
    expect(licenseChoice("  ")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The pack, built from a real project and a real recorded run
// ---------------------------------------------------------------------------

let dir: string;
let out: string;
let keys: { path: string; publicPath: string; publicKey: KeyObject };

const integrity = (text: string): string =>
  `sha512-${createHash("sha512").update(text).digest("base64")}`;

function writeLock(lodashVersion: string): void {
  const lock = {
    name: "demo-app",
    version: "1.2.3",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "demo-app",
        version: "1.2.3",
        dependencies: { lodash: lodashVersion, "@scope/util": "2.0.0", weird: "1.0.0" },
        devDependencies: { minimist: "1.2.0" },
      },
      "node_modules/lodash": {
        version: lodashVersion,
        resolved: `https://registry.npmjs.org/lodash/-/lodash-${lodashVersion}.tgz`,
        integrity: integrity(`lodash@${lodashVersion}`),
        license: "MIT",
      },
      "node_modules/@scope/util": {
        version: "2.0.0",
        integrity: integrity("util"),
        license: "(MIT OR Apache-2.0)",
        dependencies: { lodash: "^4.17.0" },
      },
      "node_modules/weird": { version: "1.0.0", license: "SEE LICENSE IN LICENSE.md" },
      "node_modules/minimist": {
        version: "1.2.0",
        integrity: integrity("minimist"),
        license: "MIT",
        dev: true,
      },
    },
  };
  writeFileSync(join(dir, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}

function writeManifest(lodashVersion: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "demo-app",
        version: "1.2.3",
        description: "A demo product",
        dependencies: { lodash: lodashVersion, "@scope/util": "2.0.0", weird: "1.0.0" },
        devDependencies: { minimist: "1.2.0" },
      },
      null,
      2,
    ),
  );
}

const lodashDetails: CveDetails = {
  id: "CVE-2021-23337",
  summary: "Command injection in lodash template",
  severity: "HIGH",
  cvssScore: 7.2,
  publishedAt: "2021-02-15T11:15:00Z",
  kev: {
    knownExploited: true,
    dateAdded: "2022-03-25",
    requiredAction: "Apply updates per vendor instructions.",
    knownRansomwareCampaignUse: "Unknown",
  },
  references: ["https://nvd.nist.gov/vuln/detail/CVE-2021-23337", "not a url"],
  affectedPackages: [
    {
      name: "lodash",
      ecosystem: "npm",
      vulnerableRange: "<4.17.21",
      firstPatchedVersion: "4.17.21",
      source: "osv",
    },
  ],
};

const result = (over: Partial<PatchResult>): PatchResult => ({
  packageName: "lodash",
  strategy: "version-bump",
  fromVersion: "4.17.20",
  toVersion: "4.17.21",
  applied: false,
  dryRun: true,
  message: "planned",
  dependencyScope: "direct",
  ...over,
});

const report = (
  cveId: string,
  details: CveDetails | null,
  results: PatchResult[],
): RemediationReport =>
  ({
    cveId,
    cveDetails: details,
    vulnerablePackages: [],
    results,
    summary: "preview",
    sbom: [
      { name: "lodash", version: "4.17.20", scope: "direct", status: "patched", cveIds: [cveId] },
    ],
  }) as RemediationReport;

const passing: VerificationResult = {
  passed: true,
  checks: [{ name: "vuln-gone", status: "passed", message: "ok", durationMs: 0 }],
  durationMs: 0,
};

/** Applies by editing the manifest and the lockfile, as the real tools do, without installing anything. */
const bumping = (): RunDeps => ({
  reinstall: vi.fn(async () => undefined),
  verify: vi.fn(async () => passing),
  attempt: async () => {
    throw new Error("no repair attempt expected");
  },
  async applyItem(item) {
    writeManifest(item.toVersion);
    writeLock(item.toVersion);
    return result({
      packageName: item.packageName,
      fromVersion: item.fromVersion,
      toVersion: item.toVersion,
      strategy: item.strategy,
      applied: true,
      dryRun: false,
      message: "applied",
    });
  },
});

let appliedRunId: string;
let plannedRunId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "evidence-pack-"));
  out = join(dir, "..", `${dir.split("/").pop()}-pack`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  writeManifest("4.17.20");
  writeLock("4.17.20");
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(
    join(dir, ".github", "autoremediator.yml"),
    [
      "suppressions:",
      "  - cveId: CVE-2099-0001",
      "    justification: mitigated",
      "    notes: input is validated upstream",
      "  - cveId: CVE-2099-0002",
      "    justification: not_affected",
      "  - cveId: CVE-2099-0003",
      "    justification: not_affected",
      "    expiresAt: 2020-01-01T00:00:00Z",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, ".gitignore"), ".autoremediator\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  // A real recorded run that is applied, with a KEV-listed advisory...
  const applied = await persistPlan(report("CVE-2021-23337", lodashDetails, [result({})]), {}, dir);
  appliedRunId = applied.runId;
  await applyPlan({ cwd: dir, runId: appliedRunId }, bumping());
  // ...and one that is only planned.
  const planned = await persistPlan(
    report(
      "GHSA-aaaa-bbbb-cccc",
      { ...lodashDetails, id: "GHSA-aaaa-bbbb-cccc", kev: undefined, references: [] },
      [
        result({
          packageName: "minimist",
          fromVersion: "1.2.0",
          toVersion: "1.2.6",
          strategy: "override",
        }),
      ],
    ),
    {},
    dir,
  );
  plannedRunId = planned.runId;

  const pair = generateKeyPairSync("ed25519");
  keys = {
    path: join(dir, "signing.pem"),
    publicPath: join(dir, "signing.pub.pem"),
    publicKey: pair.publicKey,
  };
  writeFileSync(keys.path, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(keys.publicPath, pair.publicKey.export({ type: "spki", format: "pem" }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

const read = (path: string): string => readFileSync(join(out, path), "utf8");
const readJson = (path: string): Record<string, any> =>
  JSON.parse(read(path)) as Record<string, any>;
const readEnvelope = (path: string): DsseEnvelope => JSON.parse(read(path)) as DsseEnvelope;
const NOW = new Date("2026-11-12T10:00:00Z");

describe("buildEvidencePack", () => {
  it("writes an SBOM, VEX, drafts, attestations and a manifest that all validate and verify", async () => {
    const built = await buildEvidencePack(
      { cwd: dir, outDir: out, awarenessAt: "2026-11-10T14:30:00Z", manufacturer: "Example GmbH" },
      { now: () => NOW, env: {} },
    );

    expect(built.signed).toBe(false);
    expect(built.disclaimer).toBe(EVIDENCE_PACK_DISCLAIMER);
    expect(built.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "README.md",
        "sbom/sbom.cdx.json",
        "vex/vex.cdx.json",
        "vex/vex.openvex.json",
        "cra-reports/CVE-2021-23337.md",
        `attestations/run-${appliedRunId}.intoto.json`,
        `attestations/run-${appliedRunId}.statement.json`,
        `attestations/run-${plannedRunId}.intoto.json`,
      ]),
    );

    // SBOM: CycloneDX 1.6, schema-valid, with purls, hashes, licenses and the graph.
    const bom = readJson("sbom/sbom.cdx.json");
    const validateBom = cycloneDxValidator();
    expectValid(validateBom, bom);
    expect(bom["specVersion"]).toBe("1.6");
    const byRef = new Map<string, any>(bom["components"].map((c: any) => [c["bom-ref"], c]));
    const lodash = byRef.get("pkg:npm/lodash@4.17.21");
    expect(lodash).toMatchObject({
      purl: "pkg:npm/lodash@4.17.21",
      scope: "required",
      licenses: [{ license: { id: "MIT" } }],
    });
    expect(lodash.hashes).toEqual([
      { alg: "SHA-512", content: createHash("sha512").update("lodash@4.17.21").digest("hex") },
    ]);
    expect(byRef.get("pkg:npm/%40scope/util@2.0.0")).toMatchObject({
      group: "@scope",
      name: "util",
      licenses: [{ expression: "(MIT OR Apache-2.0)" }],
    });
    expect(byRef.get("pkg:npm/weird@1.0.0").licenses).toEqual([
      { license: { name: "SEE LICENSE IN LICENSE.md" } },
    ]);
    expect(byRef.get("pkg:npm/weird@1.0.0").hashes).toBeUndefined();
    expect(byRef.get("pkg:npm/minimist@1.2.0").scope).toBe("excluded");
    const deps = new Map<string, string[]>(
      bom["dependencies"].map((d: any) => [d.ref, d.dependsOn]),
    );
    expect(deps.get("pkg:npm/demo-app@1.2.3")).toEqual(
      expect.arrayContaining(["pkg:npm/lodash@4.17.21", "pkg:npm/%40scope/util@2.0.0"]),
    );
    expect(deps.get("pkg:npm/%40scope/util@2.0.0")).toEqual(["pkg:npm/lodash@4.17.21"]);
    expect(bom["metadata"].manufacturer).toEqual({ name: "Example GmbH" });
    expect(bom["metadata"].component).toMatchObject({ name: "demo-app", version: "1.2.3" });

    // CycloneDX VEX: schema-valid, with affects by purl.
    const vex = readJson("vex/vex.cdx.json");
    expectValid(validateBom, vex);
    const byId = (id: string) => vex["vulnerabilities"].find((v: any) => v.id === id);
    expect(byId("CVE-2021-23337")).toMatchObject({
      analysis: { state: "resolved", response: ["update"] },
      affects: [
        { ref: "pkg:npm/lodash@4.17.21", versions: [{ version: "4.17.21", status: "unaffected" }] },
      ],
      source: { name: "NVD" },
      ratings: [{ score: 7.2, severity: "high", method: "other" }],
    });
    expect(byId("CVE-2021-23337").advisories).toEqual([
      { url: "https://nvd.nist.gov/vuln/detail/CVE-2021-23337" },
    ]);
    expect(byId("CVE-2021-23337").properties).toContainEqual({
      name: "cisa-kev:known-exploited",
      value: "true",
    });
    expect(byId("GHSA-aaaa-bbbb-cccc")).toMatchObject({
      analysis: { state: "exploitable", response: ["update"] },
      affects: [{ ref: "pkg:npm/minimist@1.2.0", versions: [{ status: "affected" }] }],
      recommendation: expect.stringContaining("Upgrade minimist to 1.2.6"),
    });
    expect(byId("CVE-2099-0001").analysis).toMatchObject({
      state: "not_affected",
      justification: "protected_by_mitigating_control",
    });
    expect(byId("CVE-2099-0002").analysis.state).toBe("not_affected");
    expect(byId("CVE-2099-0003")).toBeUndefined(); // expired
    expect(built.notes.join("\n")).toMatch(/1 expired suppression was left out/);

    // OpenVEX: schema-valid, statuses and justifications as the spec defines them.
    const openVex = readJson("vex/vex.openvex.json");
    const validateOpenVex = openVexValidator();
    expectValid(validateOpenVex, openVex);
    expect(openVex["@context"]).toBe("https://openvex.dev/ns/v0.2.0");
    expect(openVex["author"]).toBe("Example GmbH");
    const statement = (name: string) =>
      openVex["statements"].find((s: any) => s.vulnerability.name === name);
    expect(statement("CVE-2021-23337")).toMatchObject({
      status: "fixed",
      products: [
        { "@id": "pkg:npm/demo-app@1.2.3", subcomponents: [{ "@id": "pkg:npm/lodash@4.17.21" }] },
      ],
    });
    expect(statement("GHSA-aaaa-bbbb-cccc")).toMatchObject({
      status: "affected",
      action_statement: expect.stringContaining("Upgrade minimist to 1.2.6"),
    });
    expect(statement("CVE-2099-0001")).toMatchObject({
      status: "not_affected",
      justification: "inline_mitigations_already_exist",
    });
    expect(statement("CVE-2099-0002")).toMatchObject({
      status: "not_affected",
      impact_statement: expect.stringContaining("not affecting the product"),
    });
    expect(statement("CVE-2099-0002").justification).toBeUndefined();

    // Article 14 draft: marked, deadlines from the stated awareness time, nothing invented.
    const draft = read("cra-reports/CVE-2021-23337.md");
    expect(draft).toContain("DRAFT. NOT SUBMITTED. NOT LEGAL ADVICE. NOT A COMPLIANCE CLAIM.");
    expect(draft).toContain("2026-11-11T14:30:00.000Z");
    expect(draft).toContain("2026-11-13T14:30:00.000Z");
    expect(draft).toContain("[MANUFACTURER TO COMPLETE:");
    expect(draft).toContain("Command injection in lodash template");
    expect(draft).toContain("Example GmbH");
    expect(draft).not.toMatch(/@[a-z0-9-]+\.(com|eu|org)/i);
    expect(built.craReports).toEqual([
      expect.objectContaining({
        cveId: "CVE-2021-23337",
        file: "cra-reports/CVE-2021-23337.md",
        deadlines: expect.objectContaining({ earlyWarningDue: "2026-11-11T14:30:00.000Z" }),
      }),
    ]);
    // The advisory that is not KEV-listed has no draft.
    expect(existsSync(join(out, "cra-reports", "GHSA-aaaa-bbbb-cccc.md"))).toBe(false);

    // Run attestation: unsigned by default, with the ledger head and the verifier's results.
    const envelope = readEnvelope(`attestations/run-${appliedRunId}.intoto.json`);
    expect(envelope.signatures).toEqual([]);
    const statementJson = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    expect(read(`attestations/run-${appliedRunId}.statement.json`).trim()).toBe(
      Buffer.from(envelope.payload, "base64").toString("utf8"),
    );
    expect(statementJson._type).toBe("https://in-toto.io/Statement/v1");
    expect(statementJson.subject.map((s: any) => s.name)).toEqual(
      expect.arrayContaining(["package.json", "package-lock.json"]),
    );
    const lockDigest = createHash("sha256")
      .update(readFileSync(join(dir, "package-lock.json")))
      .digest("hex");
    expect(
      statementJson.subject.find((s: any) => s.name === "package-lock.json").digest.sha256,
    ).toBe(lockDigest);
    expect(statementJson.predicate.run).toMatchObject({
      runId: appliedRunId,
      status: "applied",
      projectMatchesRunEnd: true,
    });
    expect(statementJson.predicate.items).toEqual([
      expect.objectContaining({
        packageName: "lodash",
        toVersion: "4.17.21",
        outcome: "applied",
        verified: true,
      }),
    ]);
    expect(statementJson.predicate.ledger).toMatchObject({
      chainVerified: true,
      headHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(built.attestations.find((a) => a.runId === appliedRunId)).toMatchObject({
      signed: false,
      ledgerHead: statementJson.predicate.ledger.headHash,
    });
    const plannedStatement = JSON.parse(
      Buffer.from(
        readEnvelope(`attestations/run-${plannedRunId}.intoto.json`).payload,
        "base64",
      ).toString("utf8"),
    );
    expect(plannedStatement.predicate.items[0]).toMatchObject({ outcome: "not-attempted" });

    // Manifest and the self-check.
    const manifest = readJson("manifest.json");
    for (const entry of manifest["files"]) {
      expect(
        createHash("sha256")
          .update(readFileSync(join(out, entry.path)))
          .digest("hex"),
      ).toBe(entry.sha256);
    }
    expect(manifest["signed"]).toBe(false);
    expect(read("README.md")).toContain("UNSIGNED");
    expect(verifyEvidencePack(out)).toMatchObject({
      ok: true,
      signed: false,
      signaturesVerified: false,
    });
  });

  it("signs with a local key, verifies independently, and detects every kind of tampering", async () => {
    const built = await buildEvidencePack(
      { cwd: dir, outDir: out, signingKeyPath: keys.path },
      { now: () => NOW, env: {} },
    );
    expect(built.signed).toBe(true);
    expect(built.signingAlgorithm).toBe("ed25519");

    // Independent verification of a run attestation with node:crypto only.
    const envelope = readEnvelope(`attestations/run-${appliedRunId}.intoto.json`);
    const payload = Buffer.from(envelope.payload, "base64");
    const signedBytes = Buffer.concat([
      Buffer.from(
        `DSSEv1 ${Buffer.byteLength(envelope.payloadType)} ${envelope.payloadType} ${payload.length} `,
      ),
      payload,
    ]);
    expect(
      cryptoVerify(
        null,
        signedBytes,
        keys.publicKey,
        Buffer.from(envelope.signatures[0]!.sig, "base64"),
      ),
    ).toBe(true);
    expect(envelope.signatures[0]!.keyid).toBe(built.signingKeyId);
    expect(read("attestations/signing-public-key.pem")).toContain("BEGIN PUBLIC KEY");

    expect(verifyEvidencePack(out, { publicKeyPath: keys.publicPath })).toMatchObject({
      ok: true,
      signed: true,
      signaturesVerified: true,
    });
    // Without the key the signatures are reported as unchecked, not as fine.
    expect(verifyEvidencePack(out).notes.join(" ")).toMatch(/no signature was checked/);
    // A different key does not verify.
    const stranger = join(dir, "stranger.pub.pem");
    writeFileSync(
      stranger,
      generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }),
    );
    const wrongKey = verifyEvidencePack(out, { publicKeyPath: stranger });
    expect(wrongKey.ok).toBe(false);
    expect(wrongKey.problems.join("\n")).toMatch(
      /signature: attestations\/run-.*no signature verifies/,
    );

    // Tamper with the SBOM: the manifest catches it.
    const sbomPath = join(out, "sbom", "sbom.cdx.json");
    const sbomOriginal = readFileSync(sbomPath, "utf8");
    writeFileSync(sbomPath, sbomOriginal.replace("lodash", "lodesh"));
    expect(verifyEvidencePack(out, { publicKeyPath: keys.publicPath }).problems).toContain(
      "changed: sbom/sbom.cdx.json no longer matches its sha256 in the manifest",
    );
    writeFileSync(sbomPath, sbomOriginal);

    // Tamper with the payload of the pack attestation (which the manifest does not list): the signature catches it.
    const packPath = join(out, "attestations", "pack.intoto.json");
    const packOriginal = readFileSync(packPath, "utf8");
    const packEnvelope = JSON.parse(packOriginal) as DsseEnvelope;
    const statement = JSON.parse(Buffer.from(packEnvelope.payload, "base64").toString("utf8"));
    statement.predicate.files = 999;
    packEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    writeFileSync(packPath, JSON.stringify(packEnvelope));
    expect(verifyEvidencePack(out, { publicKeyPath: keys.publicPath }).problems.join("\n")).toMatch(
      /signature: attestations\/pack\.intoto\.json: no signature verifies/,
    );
    writeFileSync(packPath, packOriginal);

    // Re-pointing the pack attestation at a different manifest is caught even without a key.
    statement.predicate.files = 1;
    statement.subject[0].digest.sha256 = "0".repeat(64);
    packEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    writeFileSync(packPath, JSON.stringify(packEnvelope));
    expect(verifyEvidencePack(out).problems).toContain(
      "attestations/pack.intoto.json attests to a different manifest than the one in the pack",
    );
    writeFileSync(packPath, packOriginal);

    // A file added to the pack is not in the manifest.
    writeFileSync(join(out, "extra.txt"), "x");
    expect(verifyEvidencePack(out).problems).toContain(
      "unlisted: extra.txt is not in the manifest",
    );
    rmSync(join(out, "extra.txt"));

    // A removed file is missing.
    rmSync(join(out, "vex", "vex.openvex.json"));
    expect(verifyEvidencePack(out).problems).toContain("missing: vex/vex.openvex.json");
  });

  it("uses the environment key for the CLI and SDK but never for MCP or HTTP callers", async () => {
    const env = { [SIGNING_KEY_ENV]: keys.path };
    expect(
      (await buildEvidencePack({ cwd: dir, outDir: out }, { now: () => NOW, env })).signed,
    ).toBe(true);
    expect(
      (await buildEvidencePack({ cwd: dir, outDir: out, source: "cli" }, { now: () => NOW, env }))
        .signed,
    ).toBe(true);
    for (const source of ["mcp", "openapi"] as const) {
      expect(
        (await buildEvidencePack({ cwd: dir, outDir: out, source }, { now: () => NOW, env }))
          .signed,
      ).toBe(false);
    }
    // An explicit key from a remote caller is honored (the path guard confines it).
    expect(
      (
        await buildEvidencePack(
          { cwd: dir, outDir: out, source: "mcp", signingKeyPath: keys.path },
          { now: () => NOW, env: {} },
        )
      ).signed,
    ).toBe(true);
  });

  it("states the rules but no dates when no awareness time is given, and checks per-advisory times", async () => {
    const built = await buildEvidencePack({ cwd: dir, outDir: out }, { now: () => NOW, env: {} });
    expect(built.craReports[0]).not.toHaveProperty("deadlines");
    const draft = read("cra-reports/CVE-2021-23337.md");
    expect(draft).toContain("awareness + 24 hours");
    expect(draft).not.toMatch(/Due: \*\*2026/);
    expect(draft).not.toContain("2026-11-11T");
    expect(built.notes.join("\n")).toMatch(/No awareness time was given/);

    const perCve = await buildEvidencePack(
      {
        cwd: dir,
        outDir: out,
        awarenessAt: "2026-11-10T14:30:00Z",
        awarenessByCve: {
          "cve-2021-23337": "2026-11-11T08:00:00Z",
          "CVE-1999-0001": "2026-11-11T08:00:00Z",
        },
        correctiveMeasureAt: "2026-11-12T00:00:00Z",
      },
      { now: () => NOW, env: {} },
    );
    expect(perCve.craReports[0]!.deadlines).toMatchObject({
      earlyWarningDue: "2026-11-12T08:00:00.000Z",
      finalReportDue: "2026-11-26T00:00:00.000Z",
    });
    expect(perCve.notes.join("\n")).toMatch(/CVE-1999-0001, but no recorded run lists it/);

    await expect(
      buildEvidencePack({ cwd: dir, outDir: out, awarenessAt: "2026-11-10T14:30:00" }),
    ).rejects.toThrow(/time zone/);
  });

  it("does not claim a fix the lockfile no longer shows, and keeps a not-present component out of 'affected'", async () => {
    // The applied change is undone by hand: lodash 4.17.20 is locked again.
    writeLock("4.17.20");
    const built = await buildEvidencePack({ cwd: dir, outDir: out }, { now: () => NOW, env: {} });
    const vex = readJson("vex/vex.cdx.json");
    const entry = vex["vulnerabilities"].find((v: any) => v.id === "CVE-2021-23337");
    expect(entry.analysis.state).toBe("exploitable");
    expect(entry.analysis.detail).toContain("is locked again");
    expect(built.vex.byStatus.fixed).toBe(0);

    // A component that left the lockfile without a recorded fix is "not present", not "fixed".
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: {} } } }),
    );
    await buildEvidencePack({ cwd: dir, outDir: out }, { now: () => NOW, env: {} });
    const openVex = readJson("vex/vex.openvex.json");
    const minimist = openVex["statements"].find(
      (s: any) => s.vulnerability.name === "GHSA-aaaa-bbbb-cccc",
    );
    expect(minimist).toMatchObject({
      status: "not_affected",
      justification: "component_not_present",
    });
  });

  it("skips a run whose ledger was tampered with, and says why", async () => {
    const ledger = join(dir, ".autoremediator", "runs", appliedRunId, "steps.jsonl");
    writeFileSync(ledger, readFileSync(ledger, "utf8").replace('"applied"', '"failed"'));
    const built = await buildEvidencePack(
      { cwd: dir, outDir: out, signingKeyPath: keys.path },
      { now: () => NOW, env: {} },
    );
    expect(built.skippedRuns).toEqual([
      { runId: appliedRunId, reason: expect.stringMatching(/ledger failed verification/) },
    ]);
    expect(existsSync(join(out, "attestations", `run-${appliedRunId}.intoto.json`))).toBe(false);
    expect(existsSync(join(out, "attestations", `run-${plannedRunId}.intoto.json`))).toBe(true);
    // Its results are not trusted for VEX either: no "fixed" from a broken ledger.
    expect(built.vex.byStatus.fixed).toBe(0);
  });

  it("limits the pack to the runs asked for, and refuses an unknown run", async () => {
    const built = await buildEvidencePack(
      { cwd: dir, outDir: out, runIds: [plannedRunId] },
      { now: () => NOW, env: {} },
    );
    expect(built.attestations.map((a) => a.runId)).toEqual([plannedRunId]);
    await expect(
      buildEvidencePack({ cwd: dir, outDir: out, runIds: ["run_nope"] }),
    ).rejects.toThrow(/Run not found/);
  });

  it("refuses an output directory that holds something else, and replaces an earlier pack cleanly", async () => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "notes.txt"), "mine");
    await expect(buildEvidencePack({ cwd: dir, outDir: out })).rejects.toThrow(
      /not empty and does not hold an evidence pack/,
    );
    expect(readFileSync(join(out, "notes.txt"), "utf8")).toBe("mine");
    rmSync(join(out, "notes.txt"));

    await buildEvidencePack(
      { cwd: dir, outDir: out, awarenessAt: "2026-11-10T14:30:00Z" },
      { now: () => NOW, env: {} },
    );
    expect(existsSync(join(out, "cra-reports", "CVE-2021-23337.md"))).toBe(true);
    // Rebuilt after the advisory dropped out of the runs: the old draft must not linger.
    await buildEvidencePack(
      { cwd: dir, outDir: out, runIds: [plannedRunId] },
      { now: () => NOW, env: {} },
    );
    expect(existsSync(join(out, "cra-reports"))).toBe(false);
    expect(verifyEvidencePack(out).ok).toBe(true);
  });

  it("does not treat someone else's manifest.json as an earlier pack", async () => {
    mkdirSync(join(out, "assets"), { recursive: true });
    const extensionManifest = JSON.stringify({
      manifest_version: 3,
      name: "my extension",
      version: "1.0",
    });
    writeFileSync(join(out, "manifest.json"), extensionManifest);
    writeFileSync(join(out, "background.js"), "console.log('mine');");
    await expect(
      buildEvidencePack({ cwd: dir, outDir: out }, { now: () => NOW, env: {} }),
    ).rejects.toThrow(/manifest\.json is not an autoremediator evidence pack manifest/);
    expect(readFileSync(join(out, "manifest.json"), "utf8")).toBe(extensionManifest);
    expect(readFileSync(join(out, "background.js"), "utf8")).toBe("console.log('mine');");
    expect(existsSync(join(out, "assets"))).toBe(true);
  });

  it("does not treat a manifest.json that is not JSON as an earlier pack", async () => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "manifest.json"), "not json");
    await expect(
      buildEvidencePack({ cwd: dir, outDir: out }, { now: () => NOW, env: {} }),
    ).rejects.toThrow(/not an autoremediator evidence pack manifest/);
    expect(readFileSync(join(out, "manifest.json"), "utf8")).toBe("not json");
  });

  it("replaces an earlier pack but leaves what is not the pack's: other files and directories", async () => {
    await buildEvidencePack({ cwd: dir, outDir: out }, { now: () => NOW, env: {} });
    mkdirSync(join(out, "my-empty-dir"));
    mkdirSync(join(out, "vex"), { recursive: true });
    writeFileSync(join(out, "vex", "my-notes.txt"), "keep me");
    writeFileSync(join(out, "background.js"), "keep me too");
    await buildEvidencePack({ cwd: dir, outDir: out }, { now: () => NOW, env: {} });
    expect(existsSync(join(out, "my-empty-dir"))).toBe(true);
    expect(readFileSync(join(out, "vex", "my-notes.txt"), "utf8")).toBe("keep me");
    expect(readFileSync(join(out, "background.js"), "utf8")).toBe("keep me too");
    expect(existsSync(join(out, "manifest.json"))).toBe(true);
  });

  it("refuses to replace a pack whose files were changed since it was written, and deletes nothing", async () => {
    await buildEvidencePack({ cwd: dir, outDir: out }, { now: () => NOW, env: {} });
    writeFileSync(join(out, "README.md"), "my edits");
    await expect(
      buildEvidencePack({ cwd: dir, outDir: out }, { now: () => NOW, env: {} }),
    ).rejects.toThrow(/changed since the pack was written: README\.md/);
    expect(readFileSync(join(out, "README.md"), "utf8")).toBe("my edits");
    expect(existsSync(join(out, "sbom", "sbom.cdx.json"))).toBe(true);
    expect(existsSync(join(out, "manifest.json"))).toBe(true);
  });

  it("falls back to the report SBOM, with a note, when there is no lockfile", async () => {
    rmSync(join(dir, "package-lock.json"));
    const built = await buildEvidencePack({ cwd: dir, outDir: out }, { now: () => NOW, env: {} });
    expect(built.sbom.source).toBe("report");
    expect(built.notes.join("\n")).toMatch(
      /No lockfile could be read; the components come from the SBOM recorded in run reports/,
    );
    const validateBom = cycloneDxValidator();
    expectValid(validateBom, readJson("sbom/sbom.cdx.json"));
  });

  it("builds an honest, valid pack for a project with no recorded runs", async () => {
    rmSync(join(dir, ".autoremediator"), { recursive: true, force: true });
    const built = await buildEvidencePack({ cwd: dir, outDir: out }, { now: () => NOW, env: {} });
    expect(built.attestations).toEqual([]);
    expect(built.craReports).toEqual([]);
    expect(built.notes.join("\n")).toMatch(/No recorded runs were found/);
    const validateBom = cycloneDxValidator();
    expectValid(validateBom, readJson("vex/vex.cdx.json"));
    expect(openVexValidator()(readJson("vex/vex.openvex.json"))).toBe(true);
    expect(verifyEvidencePack(out).ok).toBe(true);
  });
});

describe("toCycloneDxVex 1.6", () => {
  const vexReport = (results: PatchResult[]): RemediationReport =>
    report("CVE-2021-23337", null, results);

  it("keeps emitting 1.5 unless asked, and the 1.5 shape is unchanged", () => {
    const doc = toCycloneDxVex(vexReport([result({})]));
    expect(doc.specVersion).toBe("1.5");
    expect(doc).not.toHaveProperty("components");
    expect(doc.vulnerabilities[0]).not.toHaveProperty("affects");
  });

  it("emits schema-valid 1.6 with affects, mapping policy justifications to CycloneDX values", () => {
    const validate = cycloneDxValidator();
    for (const justification of [
      "not_affected",
      "mitigated",
      "fixed",
      "under_investigation",
    ] as const) {
      const doc = toCycloneDxVex(
        vexReport([result({ suppressedBy: { justification, notes: "n" } })]),
        {
          specVersion: "1.6",
          toolVersion: "9.9.9",
        },
      );
      expectValid(validate, doc);
      expect(doc.vulnerabilities[0]!.affects).toEqual([
        { ref: "pkg:npm/lodash@4.17.20", versions: [{ version: "4.17.20", status: "affected" }] },
      ]);
    }
    const mitigated = toCycloneDxVex(
      vexReport([result({ suppressedBy: { justification: "mitigated" } })]),
      { specVersion: "1.6" },
    );
    expect(mitigated.vulnerabilities[0]!.analysis).toMatchObject({
      state: "not_affected",
      justification: "protected_by_mitigating_control",
    });
    const fixed = toCycloneDxVex(
      vexReport([result({ suppressedBy: { justification: "fixed" } })]),
      { specVersion: "1.6" },
    );
    expect(fixed.vulnerabilities[0]!.analysis.state).toBe("resolved");

    const unresolved = toCycloneDxVex(
      vexReport([result({ unresolvedReason: "no-safe-version" })]),
      { specVersion: "1.6" },
    );
    expectValid(validate, unresolved);
  });
});
