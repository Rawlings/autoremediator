import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFake, vexDocument } from "../platform/maintainer-vex/__tests__/fixtures.js";
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

const byName = (name: string) => OPERATIONS.find((operation) => operation.name === name)!;

let dir: string;
let deps: ApiDeps;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maintainer-vex-catalog-"));
  deps = {
    readMaintainerVexFn: vi.fn(() => ({ schemaVersion: "1.0", packages: [] })),
    maintainFn: vi.fn(async () => ({ schemaVersion: "1.0" })),
  } as unknown as ApiDeps;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readMaintainerVex on every surface", () => {
  it("is a read-only MCP tool, HTTP route and OpenAPI path", () => {
    expect(toMcpTools().map((tool) => tool.name)).toContain("readMaintainerVex");
    expect(byName("readMaintainerVex").annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(matchHttpRoute("POST", "/maintainer-vex")?.operation.name).toBe("readMaintainerVex");
    expect(Object.keys(toOpenApiPaths())).toContain("/maintainer-vex");
    expect(roleFor(byName("readMaintainerVex"))).toBe("reader");
    expect(
      mapRequestToInput(byName("readMaintainerVex"), { options: { advisory: "CVE-2026-1" } }),
    ).toEqual({
      ok: true,
      input: { advisory: "CVE-2026-1" },
    });
  });

  it("reads real documents through the MCP adapter, confined to the allowed roots", async () => {
    installFake(dir, { name: "bad-dep", version: "1.0.0" });
    installFake(dir, {
      name: "lib",
      version: "2.0.0",
      dependencies: { "bad-dep": "^1" },
      vex: true,
      files: {
        "vex.openvex.json": vexDocument({ name: "lib", version: "2.0.0" }, [
          { vulnerability: "CVE-2026-1111" },
        ]),
      },
    });
    const { defaultApiDeps } = await import("./api-deps.js");
    const env = { AUTOREMEDIATOR_ALLOWED_ROOTS: dir };

    const ok = await callMcpOperation("readMaintainerVex", { cwd: dir }, defaultApiDeps, { env });
    expect(ok.isError).toBeUndefined();
    const report = JSON.parse(ok.content[0]!.text) as { packages: Array<{ name: string }> };
    expect(report.packages.map((entry) => entry.name)).toEqual(["lib"]);

    const refused = await callMcpOperation("readMaintainerVex", { cwd: "/etc" }, deps, { env });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("Path not allowed");
    expect(deps.readMaintainerVexFn).not.toHaveBeenCalled();
  });

  it("rejects unknown fields", async () => {
    expect((await callMcpOperation("readMaintainerVex", { surprise: 1 }, deps)).isError).toBe(true);
  });
});

describe("maintain is command line and SDK only", () => {
  it("is neither an MCP tool nor an HTTP route", () => {
    expect(byName("maintain").mcp).toBe(false);
    expect(byName("maintain").http).toBeUndefined();
    expect(toMcpTools().map((tool) => tool.name)).not.toContain("maintain");
    expect(Object.keys(toOpenApiPaths())).not.toContain("/maintain");
    expect(matchHttpRoute("POST", "/maintain")).toBeUndefined();
  });

  it("passes its options and provenance to the SDK function", async () => {
    const operation = byName("maintain");
    await operation.handler(
      operation.input.parse({ advisories: ["CVE-2026-1111"], assertNotAffected: true, yes: true }),
      { api: deps, source: "sdk", operationNames: [] },
    );
    expect(deps.maintainFn).toHaveBeenCalledWith({
      advisories: ["CVE-2026-1111"],
      assertNotAffected: true,
      yes: true,
      source: "sdk",
    });
  });
});
