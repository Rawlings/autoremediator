import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiDeps } from "./api-deps.js";
import {
  callMcpOperation,
  inputJsonSchema,
  mapRequestToInput,
  matchHttpRoute,
  OPERATIONS,
  roleFor,
  toMcpTools,
  toOpenApiPaths,
} from "./index.js";

const operation = OPERATIONS.find((candidate) => candidate.name === "generateProofOfFix")!;

let dir: string;
let deps: ApiDeps;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prove-catalog-"));
  deps = { generateProofOfFixFn: vi.fn(async () => ({ status: "kept" })) } as unknown as ApiDeps;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("generateProofOfFix on every surface", () => {
  it("is an MCP tool, an HTTP route and an OpenAPI path generated from the catalog", () => {
    expect(toMcpTools().map((tool) => tool.name)).toContain("generateProofOfFix");
    expect(matchHttpRoute("POST", "/proof-of-fix/generate")?.operation.name).toBe("generateProofOfFix");
    expect(Object.keys(toOpenApiPaths())).toContain("/proof-of-fix/generate");
    // It writes files into the project's patches directory, runs a model and uses the network, but
    // changes no dependency: an operator, not an admin; not read-only.
    expect(operation.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(roleFor(operation)).toBe("operator");
  });

  it("takes the advisory at the top level of an HTTP body and the rest under options", () => {
    expect(
      mapRequestToInput(operation, { cveId: "GHSA-abcd-efgh-ijkl", options: { package: "lodash", maxTrials: 2 } }),
    ).toEqual({ ok: true, input: { package: "lodash", maxTrials: 2, cveId: "GHSA-abcd-efgh-ijkl" } });
    expect(mapRequestToInput(operation, { cveId: "x", package: "lodash" })).toMatchObject({ ok: false });
  });

  it("marks the key and the patches directory as paths, so remote callers are confined to the allowed roots", () => {
    const properties = (inputJsonSchema(operation) as { properties: Record<string, { "x-path"?: boolean }> }).properties;
    expect(properties["signingKeyPath"]?.["x-path"]).toBe(true);
    expect(properties["patchesDir"]?.["x-path"]).toBe(true);
    expect(properties["cwd"]?.["x-path"]).toBe(true);
  });

  it("does not let a remote caller replace a script a person wrote, or hand in an agent", async () => {
    expect(Object.keys(operation.input.shape)).not.toContain("overwrite");
    expect(Object.keys(operation.input.shape)).not.toContain("agent");
    await expect(
      callMcpOperation("generateProofOfFix", { cveId: "GHSA-abcd-efgh-ijkl", overwrite: true }, deps),
    ).resolves.toMatchObject({ isError: true });
    expect(deps.generateProofOfFixFn).not.toHaveBeenCalled();
  });

  it("refuses a signing key or patches directory outside the allowed roots", async () => {
    const env = { AUTOREMEDIATOR_ALLOWED_ROOTS: dir };
    for (const extra of [{ signingKeyPath: "/etc/passwd" }, { patchesDir: "/etc/patches" }, { cwd: "/etc" }]) {
      const result = await callMcpOperation(
        "generateProofOfFix",
        { cveId: "GHSA-abcd-efgh-ijkl", cwd: dir, ...extra },
        deps,
        { env },
      );
      expect([extra, result.isError, result.content[0]?.text]).toEqual([
        extra,
        true,
        expect.stringContaining("Path not allowed"),
      ]);
    }
    expect(deps.generateProofOfFixFn).not.toHaveBeenCalled();
  });

  it("calls the SDK function with the advisory and the options", async () => {
    await callMcpOperation(
      "generateProofOfFix",
      { cveId: "GHSA-abcd-efgh-ijkl", package: "lodash", cwd: dir, model: "anthropic:x" },
      deps,
      { env: { AUTOREMEDIATOR_ALLOWED_ROOTS: dir } },
    );
    expect(deps.generateProofOfFixFn).toHaveBeenCalledWith("GHSA-abcd-efgh-ijkl", {
      package: "lodash",
      cwd: dir,
      model: "anthropic:x",
    });
  });
});
