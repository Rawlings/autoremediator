import { mkdtempSync, rmSync } from "node:fs";
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

const radar = OPERATIONS.find((operation) => operation.name === "radar")!;

let dir: string;
let deps: ApiDeps;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "radar-catalog-"));
  deps = {
    radarFn: vi.fn(async () => ({ schemaVersion: "1.0", entries: [] })),
  } as unknown as ApiDeps;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("radar on every surface", () => {
  it("is an MCP tool, an HTTP route and an OpenAPI path generated from the catalog", () => {
    expect(toMcpTools().map((tool) => tool.name)).toContain("radar");
    expect(radar.http).toEqual({ method: "POST", path: "/radar", positional: [] });
    expect(matchHttpRoute("POST", "/radar")?.operation.name).toBe("radar");
    expect(Object.keys(toOpenApiPaths())).toContain("/radar");
    // It downloads package data but changes nothing: a reader may call it.
    expect(radar.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(roleFor(radar)).toBe("reader");
  });

  it("describes itself without claiming a vulnerability exists", () => {
    expect(radar.description).toContain("Never states that a vulnerability exists");
    expect(radar.description).toContain("without a published advisory");
  });

  it("takes options at the top level over MCP and under options over HTTP", () => {
    expect(mapRequestToInput(radar, { options: { includeTransitive: true, limit: 5 } })).toEqual({
      ok: true,
      input: { includeTransitive: true, limit: 5 },
    });
    expect(mapRequestToInput(radar, {})).toEqual({ ok: true, input: {} });
    expect(mapRequestToInput(radar, { limit: 5 })).toMatchObject({ ok: false });
  });

  it("validates input and passes the call source to the SDK", async () => {
    expect((await callMcpOperation("radar", { limit: 0 }, deps)).isError).toBe(true);
    expect((await callMcpOperation("radar", { target: "next" }, deps)).isError).toBe(true);
    expect((await callMcpOperation("radar", { surprise: true }, deps)).isError).toBe(true);
    expect(deps.radarFn).not.toHaveBeenCalled();

    const ok = await callMcpOperation(
      "radar",
      { cwd: dir, target: "minor", github: true, includeTransitive: true },
      deps,
      { env: { AUTOREMEDIATOR_ALLOWED_ROOTS: dir } },
    );
    expect(ok.isError).toBeUndefined();
    expect(deps.radarFn).toHaveBeenCalledWith({
      cwd: dir,
      target: "minor",
      github: true,
      includeTransitive: true,
      source: "mcp",
    });
  });

  it("confines the project directory an untrusted caller names", async () => {
    const result = await callMcpOperation("radar", { cwd: "/etc" }, deps, {
      env: { AUTOREMEDIATOR_ALLOWED_ROOTS: dir },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Path not allowed");
    expect(deps.radarFn).not.toHaveBeenCalled();
  });
});
