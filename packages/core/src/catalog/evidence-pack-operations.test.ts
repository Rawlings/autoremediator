import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiDeps } from "./api-deps.js";
import {
  callMcpOperation,
  mapRequestToInput,
  matchHttpRoute,
  OPERATIONS,
  roleFor,
  toMcpTools,
  toOpenApiPaths,
} from "./index.js";

const operation = OPERATIONS.find((candidate) => candidate.name === "buildEvidencePack")!;

let dir: string;
let deps: ApiDeps;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "evidence-catalog-"));
  deps = { buildEvidencePackFn: vi.fn(async () => ({ schemaVersion: "1" })) } as unknown as ApiDeps;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildEvidencePack on every surface", () => {
  it("is an MCP tool, an HTTP route and an OpenAPI path generated from the catalog", () => {
    expect(toMcpTools().map((tool) => tool.name)).toContain("buildEvidencePack");
    expect(matchHttpRoute("POST", "/evidence-pack")?.operation.name).toBe("buildEvidencePack");
    expect(Object.keys(toOpenApiPaths())).toContain("/evidence-pack");
    // It writes files (under outDir only), replacing an earlier pack there, and never touches the network or the dependencies.
    expect(operation.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(roleFor(operation)).toBe("admin");
  });

  it("nests every option under options over HTTP and rejects unknown or key-material fields", async () => {
    expect(
      mapRequestToInput(operation, {
        options: { outDir: "/x", awarenessAt: "2026-11-10T14:30:00Z" },
      }),
    ).toEqual({
      ok: true,
      input: { outDir: "/x", awarenessAt: "2026-11-10T14:30:00Z" },
    });
    expect(mapRequestToInput(operation, { outDir: "/x" })).toMatchObject({ ok: false });
    for (const args of [
      {},
      { outDir: dir, signingKey: "-----BEGIN PRIVATE KEY-----" },
      { outDir: dir, privateKey: "x" },
      { outDir: dir, awarenessAt: "" },
    ]) {
      expect((await callMcpOperation("buildEvidencePack", args, deps)).isError).toBe(true);
    }
    expect(deps.buildEvidencePackFn).not.toHaveBeenCalled();
  });

  it("confines the output directory, the signing key path, the policy and the project to the allowed roots", async () => {
    const env = { AUTOREMEDIATOR_ALLOWED_ROOTS: dir };
    for (const args of [
      { outDir: "/etc/pack" },
      { outDir: join(dir, "pack"), signingKeyPath: "/etc/ssl/private/key.pem" },
      { outDir: join(dir, "pack"), signingKeyPath: join(dir, "..", "key.pem") },
      { outDir: join(dir, "pack"), policy: "/etc/policy.yml" },
      { outDir: join(dir, "pack"), cwd: "/etc" },
    ]) {
      const result = await callMcpOperation("buildEvidencePack", args, deps, { env });
      expect([args, result.isError, result.content[0]?.text]).toEqual([
        args,
        true,
        expect.stringContaining("Path not allowed"),
      ]);
    }
    expect(deps.buildEvidencePackFn).not.toHaveBeenCalled();

    const keyPath = join(dir, "key.pem");
    writeFileSync(
      keyPath,
      generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    const ok = await callMcpOperation(
      "buildEvidencePack",
      { outDir: join(dir, "pack"), signingKeyPath: keyPath, cwd: dir },
      deps,
      { env },
    );
    expect(ok.isError).toBeUndefined();
    expect(deps.buildEvidencePackFn).toHaveBeenCalledWith({
      outDir: join(dir, "pack"),
      signingKeyPath: keyPath,
      cwd: dir,
      source: "mcp",
    });
  });

  it("passes toVex a specVersion, and keeps 1.5 the default", async () => {
    const toVexFn = vi.fn(() => ({ bomFormat: "CycloneDX" }));
    const vexDeps = { toVexFn } as unknown as ApiDeps;
    await callMcpOperation("toVex", { report: { cveId: "CVE-1" } }, vexDeps);
    expect(toVexFn).toHaveBeenLastCalledWith({ cveId: "CVE-1" }, undefined);
    await callMcpOperation("toVex", { report: { cveId: "CVE-1" }, specVersion: "1.6" }, vexDeps);
    expect(toVexFn).toHaveBeenLastCalledWith({ cveId: "CVE-1" }, { specVersion: "1.6" });
    expect(
      (await callMcpOperation("toVex", { report: {}, specVersion: "1.4" }, vexDeps)).isError,
    ).toBe(true);
  });
});
