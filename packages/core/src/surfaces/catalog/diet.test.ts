import { afterEach, describe, expect, it, vi } from "vitest";

import { installed, makeProject, removeProjects } from "../../features/diet/testing/project.js";
import type { ApiDeps } from "./api-deps.js";
import {
  callMcpOperation,
  defaultApiDeps,
  getOperation,
  httpOperations,
  matchHttpRoute,
  roleFor,
  toMcpTools,
} from "./index.js";

afterEach(removeProjects);

describe("analyzeDependencies in the catalog", () => {
  it("is a read-only MCP tool and the HTTP route POST /packages/diet", () => {
    const operation = getOperation("analyzeDependencies")!;
    expect(operation.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(operation.mcp).toBe(true);
    expect(toMcpTools().map((tool) => tool.name)).toContain("analyzeDependencies");
    expect(operation.http).toEqual({ method: "POST", path: "/packages/diet", positional: [] });
    expect(httpOperations.map((entry) => entry.name)).toContain("analyzeDependencies");
    expect(matchHttpRoute("POST", "/packages/diet")?.operation.name).toBe("analyzeDependencies");
    expect(roleFor(operation)).toBe("reader");
  });

  it("returns the report over MCP, structured, and rejects unknown fields", async () => {
    const dir = makeProject({
      "package.json": { name: "app", dependencies: { ghost: "1" } },
      "index.js": "",
    });
    installed(dir, { ghost: true });
    const result = await callMcpOperation("analyzeDependencies", { cwd: dir }, defaultApiDeps, {
      env: { AUTOREMEDIATOR_ALLOWED_ROOTS: dir },
    });
    expect(result.isError).toBeUndefined();
    const report = result.structuredContent as {
      summary: { certainlyUnused: number };
      attackSurface: { score: number };
    };
    expect(report.summary.certainlyUnused).toBe(1);
    expect(report.attackSurface.score).toBeGreaterThanOrEqual(0);

    const bad = await callMcpOperation(
      "analyzeDependencies",
      { cwd: dir, apply: true },
      defaultApiDeps,
      { env: { AUTOREMEDIATOR_ALLOWED_ROOTS: dir } },
    );
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain("apply");
  });

  it("keeps the path inside the allowed roots", async () => {
    const result = await callMcpOperation("analyzeDependencies", { cwd: "/etc" }, defaultApiDeps, {
      env: { AUTOREMEDIATOR_ALLOWED_ROOTS: process.cwd() },
    });
    expect(result.isError).toBe(true);
  });

  it("passes cwd through to the SDK", async () => {
    const analyzeDependenciesFn = vi.fn(async () => ({ summary: {} }));
    await callMcpOperation("analyzeDependencies", { cwd: process.cwd() }, {
      ...defaultApiDeps,
      analyzeDependenciesFn,
    } as unknown as ApiDeps);
    expect(analyzeDependenciesFn).toHaveBeenCalledWith({ cwd: process.cwd() });
  });
});

describe("removing dependencies is not reachable over MCP or HTTP", () => {
  it("is defined once in the catalog but exposed on neither", async () => {
    const operation = getOperation("removeUnusedDependencies")!;
    expect(operation.mcp).toBe(false);
    expect(operation.http).toBeUndefined();
    expect(operation.annotations.destructiveHint).toBe(true);
    expect(toMcpTools().map((tool) => tool.name)).not.toContain("removeUnusedDependencies");
    expect(matchHttpRoute("POST", "/packages/diet/apply")).toBeUndefined();
    expect((await callMcpOperation("removeUnusedDependencies", {}, defaultApiDeps)).isError).toBe(
      true,
    );
  });
});
