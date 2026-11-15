import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiDeps } from "./api-deps.js";
import { defaultApiDeps } from "./api-deps.js";
import {
  callMcpOperation,
  mapRequestToInput,
  matchHttpRoute,
  OPERATIONS,
  roleFor,
  toMcpTools,
  toOpenApiPaths,
} from "./index.js";

const byName = (name: string) => OPERATIONS.find((operation) => operation.name === name)!;

let dir: string;
let deps: ApiDeps;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "policy-catalog-"));
  deps = {
    compilePolicyFn: vi.fn(async () => ({ status: "proposed" })),
    explainPolicyFn: vi.fn(() => ({ sentences: [] })),
  } as unknown as ApiDeps;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("compilePolicy and explainPolicy on every surface", () => {
  it("are MCP tools, HTTP routes and OpenAPI paths; explain is a read, compile spends model tokens so it needs operator", () => {
    for (const name of ["compilePolicy", "explainPolicy"]) {
      expect(toMcpTools().map((tool) => tool.name)).toContain(name);
    }
    expect(byName("explainPolicy").annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(roleFor(byName("explainPolicy"))).toBe("reader");
    // It writes nothing, but it sends the policy and the request to a model provider the caller chooses.
    expect(byName("compilePolicy").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(roleFor(byName("compilePolicy"))).toBe("operator");
    expect(matchHttpRoute("POST", "/policy/compile")?.operation.name).toBe("compilePolicy");
    expect(matchHttpRoute("POST", "/policy/explain")?.operation.name).toBe("explainPolicy");
    expect(Object.keys(toOpenApiPaths())).toEqual(
      expect.arrayContaining(["/policy/compile", "/policy/explain"]),
    );
    expect(byName("explainPolicy").annotations.openWorldHint).toBe(false);
  });

  it("cannot write: the wire input has no apply, and unknown fields are refused", async () => {
    const shape = Object.keys(byName("compilePolicy").input.shape);
    expect(shape).not.toContain("apply");
    const result = await callMcpOperation(
      "compilePolicy",
      { request: "don't touch left-pad", apply: true },
      deps,
    );
    expect(result.isError).toBe(true);
    expect(deps.compilePolicyFn).not.toHaveBeenCalled();
  });

  it("passes the request and options to the SDK with no apply", async () => {
    const result = await callMcpOperation(
      "compilePolicy",
      { request: "don't touch left-pad", cwd: dir, allowLoosening: false },
      deps,
      { env: { AUTOREMEDIATOR_ALLOWED_ROOTS: dir } },
    );
    expect(result.isError).toBeUndefined();
    expect(deps.compilePolicyFn).toHaveBeenCalledWith("don't touch left-pad", {
      cwd: dir,
      allowLoosening: false,
    });
    expect(
      mapRequestToInput(byName("compilePolicy"), { request: "x", options: { model: "a:b" } }),
    ).toEqual({ ok: true, input: { model: "a:b", request: "x" } });
  });

  it("requires a request and caps its length before any model is called", async () => {
    expect((await callMcpOperation("compilePolicy", {}, deps)).isError).toBe(true);
    expect(
      (await callMcpOperation("compilePolicy", { request: "x".repeat(2001) }, deps)).isError,
    ).toBe(true);
    expect(deps.compilePolicyFn).not.toHaveBeenCalled();
  });

  it("confines the project and the policy file to the allowed roots", async () => {
    const env = { AUTOREMEDIATOR_ALLOWED_ROOTS: dir };
    for (const [name, args] of [
      ["compilePolicy", { request: "x", cwd: "/etc" }],
      ["compilePolicy", { request: "x", cwd: dir, policy: "/etc/policy.yml" }],
      ["compilePolicy", { request: "x", cwd: dir, policy: "../outside.yml" }],
      ["explainPolicy", { cwd: dir, policy: "/etc/policy.yml" }],
    ] as const) {
      const result = await callMcpOperation(name, args, deps, { env });
      expect([name, result.content[0]?.text]).toEqual([
        name,
        expect.stringContaining("Path not allowed"),
      ]);
    }
    expect(deps.compilePolicyFn).not.toHaveBeenCalled();
    expect(deps.explainPolicyFn).not.toHaveBeenCalled();
  });

  it("explainPolicy answers over MCP from the real SDK, with no model", async () => {
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, ".github/autoremediator.yml"), "denyPackages: [left-pad]\n");
    const result = await callMcpOperation("explainPolicy", { cwd: dir }, defaultApiDeps, {
      env: { AUTOREMEDIATOR_ALLOWED_ROOTS: dir },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Never touch these packages: left-pad.");
  });

  it("compilePolicy over MCP never writes, even with a model that proposes a change", async () => {
    mkdirSync(join(dir, ".github"), { recursive: true });
    const file = join(dir, ".github/autoremediator.yml");
    writeFileSync(file, "allowMajorBumps: false\n");
    const real = defaultApiDeps.compilePolicyFn;
    const result = await callMcpOperation(
      "compilePolicy",
      { request: "don't touch left-pad", cwd: dir },
      {
        ...defaultApiDeps,
        compilePolicyFn: (request, options) =>
          real(request, {
            ...options,
            proposer: async () => ({
              patch: { denyPackages: { add: ["left-pad"] } },
              explanations: [{ phrase: "don't touch left-pad", keys: ["denyPackages"] }],
              unsupported: [],
            }),
          }),
      },
      { env: { AUTOREMEDIATOR_ALLOWED_ROOTS: dir } },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('"status": "proposed"');
    expect(readFileSync(file, "utf8")).toBe("allowMajorBumps: false\n");
  });
});
