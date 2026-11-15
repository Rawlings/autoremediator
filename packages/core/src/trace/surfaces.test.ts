import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { callMcpOperation, getOperation, inputJsonSchema, OPERATIONS } from "../catalog/index.js";
import type { ApiDeps } from "../catalog/index.js";
import { assertPathsConfined, PathNotAllowedError } from "../platform/path-guard.js";

describe("trace surfaces", () => {
  const operation = getOperation("checkReachability");
  if (!operation) throw new Error("checkReachability is not in the catalog");

  it("takes traceFile on MCP and HTTP as a guarded path", () => {
    const schema = inputJsonSchema(operation) as {
      properties: Record<string, { "x-path"?: boolean }>;
    };
    expect(schema.properties["traceFile"]?.["x-path"]).toBe(true);
    expect(() =>
      assertPathsConfined(schema, { packageName: "lodash", traceFile: "../../etc/passwd" }, [
        process.cwd(),
      ]),
    ).toThrow(PathNotAllowedError);
    expect(() =>
      assertPathsConfined(
        schema,
        { packageName: "lodash", traceFile: ".autoremediator/trace.json" },
        [process.cwd()],
      ),
    ).not.toThrow();
  });

  it("passes traceFile through to checkReachability", async () => {
    const checkReachabilityFn = vi.fn(async () => ({ status: "reachable" }));
    await callMcpOperation(
      "checkReachability",
      { packageName: "lodash", symbol: "template", traceFile: "t.json" },
      { checkReachabilityFn } as unknown as ApiDeps,
    );
    expect(checkReachabilityFn).toHaveBeenCalledWith({
      packageName: "lodash",
      symbol: "template",
      cwd: undefined,
      traceFile: resolve("t.json"),
    });
  });

  it("does not offer running a command to remote callers", () => {
    // traceRun starts an arbitrary local program, so it exists on the SDK and CLI only.
    expect(OPERATIONS.map((candidate) => candidate.name)).not.toContain("traceRun");
  });
});
