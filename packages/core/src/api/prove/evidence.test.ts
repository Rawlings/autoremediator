import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findEvidence, verifyRecordSignature } from "./evidence.js";
import { proofEvidenceRefs } from "./index.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "evidence-"));
  mkdirSync(join(cwd, "patches"));
  writeFileSync(join(cwd, "patches", "x.test.cjs"), "process.exit(0)");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const record = (overrides: Record<string, unknown>) => ({
  schemaVersion: "1.0",
  kind: "proof-of-fix-evidence",
  advisoryId: "CVE-2021-1",
  package: "x",
  vulnerableVersion: "1.0.0",
  fixedVersion: "1.0.1",
  script: { path: "patches/x.test.cjs", sha256: "0".repeat(64) },
  ...overrides,
});

describe("committed evidence files are untrusted", () => {
  it("skips a record whose fields have the wrong shape instead of crashing VEX output", () => {
    for (const [name, overrides] of Object.entries({
      aliasesString: { aliases: "GHSA-aaaa-bbbb-cccc" },
      aliasesObject: { aliases: { a: 1 } },
      noVersions: { vulnerableVersion: undefined },
    })) {
      writeFileSync(join(cwd, "patches", `${name}.proof.json`), JSON.stringify(record(overrides)));
    }
    writeFileSync(join(cwd, "patches", "ok.proof.json"), JSON.stringify(record({ aliases: ["GHSA-aaaa-bbbb-cccc"] })));
    expect(findEvidence(cwd, "patches").map((found) => found.recordPath.split("/").at(-1))).toEqual(["ok.proof.json"]);
    expect(() => proofEvidenceRefs(cwd, "patches")).not.toThrow();
  });
});

describe("verifyRecordSignature", () => {
  it("reports a null or non-object signature file as invalid instead of throwing", () => {
    for (const text of ["null", "5", '"x"', "[]"]) {
      expect(verifyRecordSignature(Buffer.from("{}"), text, "/nonexistent.pem").valid).toBe(false);
    }
  });
});
