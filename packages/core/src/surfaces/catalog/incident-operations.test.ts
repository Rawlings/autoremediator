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

const byName = (name: string) => OPERATIONS.find((operation) => operation.name === name)!;

let dir: string;
let deps: ApiDeps;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "incident-catalog-"));
  deps = {
    incidentFn: vi.fn(async () => ({ schemaVersion: "1.0" })),
    premortemFn: vi.fn(async () => ({ schemaVersion: "1.0" })),
  } as unknown as ApiDeps;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("incident and premortem on every surface", () => {
  it("are MCP tools, HTTP routes and OpenAPI paths generated from the catalog", () => {
    for (const name of ["incident", "premortem"]) {
      expect(toMcpTools().map((tool) => tool.name)).toContain(name);
      expect(byName(name).http).toBeDefined();
      // They write only when asked, so they are not read-only; they never edit the project's dependencies.
      expect(byName(name).annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(roleFor(byName(name))).toBe("operator");
    }
    expect(matchHttpRoute("POST", "/incident")?.operation.name).toBe("incident");
    expect(matchHttpRoute("POST", "/premortem")?.operation.name).toBe("premortem");
    expect(Object.keys(toOpenApiPaths())).toEqual(
      expect.arrayContaining(["/incident", "/premortem"]),
    );
    // Package analysis uses the network (advisory lookup, registry); reading checkouts does not.
    expect(byName("incident").annotations.openWorldHint).toBe(true);
    expect(byName("premortem").annotations.openWorldHint).toBe(false);
  });

  it("take the target at the top level of an HTTP body and the rest under options", () => {
    expect(
      mapRequestToInput(byName("incident"), {
        target: "evil@1.0.0",
        options: { plan: true, offline: true },
      }),
    ).toEqual({
      ok: true,
      input: { plan: true, offline: true, target: "evil@1.0.0" },
    });
    expect(mapRequestToInput(byName("incident"), { target: "x", plan: true })).toMatchObject({
      ok: false,
    });
    expect(mapRequestToInput(byName("premortem"), { options: { root: dir } })).toEqual({
      ok: true,
      input: { root: dir },
    });
  });

  it("require a target and reject unknown fields", async () => {
    expect((await callMcpOperation("incident", {}, deps)).isError).toBe(true);
    expect(
      (await callMcpOperation("incident", { target: "x@1", surprise: true }, deps)).isError,
    ).toBe(true);
    expect((await callMcpOperation("premortem", { top: 0 }, deps)).isError).toBe(true);
    expect(deps.incidentFn).not.toHaveBeenCalled();
  });

  it("confine every path an untrusted caller names, including the output directory", async () => {
    const env = { AUTOREMEDIATOR_ALLOWED_ROOTS: dir };
    const refused = [
      ["incident", { target: "x@1", cwd: "/etc" }],
      ["incident", { target: "x@1", cwd: dir, outputDir: "/etc/incident" }],
      ["incident", { target: "x@1", cwd: dir, intelligenceSnapshotPath: "/etc/passwd" }],
      ["incident", { target: "x@1", cwd: dir, policy: "/etc/policy.yml" }],
      ["premortem", { root: "/etc" }],
      ["premortem", { targets: [{ cwd: dir }, { cwd: "/etc" }] }],
      ["premortem", { root: dir, outputDir: "/etc/playbooks" }],
    ] as const;
    for (const [name, args] of refused) {
      const result = await callMcpOperation(name, args as Record<string, unknown>, deps, { env });
      expect([name, result.isError, result.content[0]?.text]).toEqual([
        name,
        true,
        expect.stringContaining("Path not allowed"),
      ]);
    }
    expect(deps.incidentFn).not.toHaveBeenCalled();
    expect(deps.premortemFn).not.toHaveBeenCalled();

    const outputDir = join(dir, "report");
    const ok = await callMcpOperation(
      "incident",
      { target: "x@1", cwd: dir, outputDir, plan: true },
      deps,
      { env },
    );
    expect(ok.isError).toBeUndefined();
    expect(deps.incidentFn).toHaveBeenCalledWith("x@1", {
      cwd: dir,
      outputDir,
      plan: true,
      source: "mcp",
    });

    const okPremortem = await callMcpOperation(
      "premortem",
      { targets: [{ cwd: dir }], outputDir: join(dir, "p") },
      deps,
      { env },
    );
    expect(okPremortem.isError).toBeUndefined();
    expect(deps.premortemFn).toHaveBeenCalledWith({
      targets: [{ cwd: dir }],
      outputDir: join(dir, "p"),
    });
  });
});
