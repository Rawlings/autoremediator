/** Remediation memory as an MCP host sees it: a read-only tool and a resource, and nothing that writes. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMemory } from "../../api/index.js";
import {
  callMcpOperation,
  mapRequestToInput,
  matchHttpRoute,
  OPERATIONS,
  roleFor,
  toMcpTools,
  toOpenApiPaths,
} from "../catalog/index.js";
import { createMcpServer } from "./server.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-memory-")));
  writeFileSync(join(dir, "package.json"), '{"name":"app"}');
  vi.stubEnv("AUTOREMEDIATOR_ALLOWED_ROOTS", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ projectDir: dir });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const byName = (name: string) => OPERATIONS.find((operation) => operation.name === name)!;

describe("the catalog", () => {
  it("exposes listMemory everywhere, as a read-only reader operation", () => {
    expect(toMcpTools().map((tool) => tool.name)).toContain("listMemory");
    expect(byName("listMemory").annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(roleFor(byName("listMemory"))).toBe("reader");
    expect(matchHttpRoute("POST", "/memory/list")?.operation.name).toBe("listMemory");
    expect(Object.keys(toOpenApiPaths())).toContain("/memory/list");
    expect(mapRequestToInput(byName("listMemory"), { options: { kind: "note" } })).toEqual({
      ok: true,
      input: { kind: "note" },
    });
  });

  it("keeps every writer off MCP and HTTP: an agent can only propose, inside the repair toolset", () => {
    const tools = new Set(toMcpTools().map((tool) => tool.name));
    for (const name of [
      "addMemory",
      "acceptMemory",
      "removeMemory",
      "pruneMemory",
      "proposeMemory",
    ]) {
      expect([name, tools.has(name)]).toEqual([name, false]);
    }
    for (const name of ["addMemory", "acceptMemory", "removeMemory", "pruneMemory"]) {
      expect([name, byName(name).mcp, byName(name).http]).toEqual([name, false, undefined]);
    }
    expect(OPERATIONS.some((operation) => operation.name === "proposeMemory")).toBe(false);
  });

  it("refuses a project directory outside the allowed roots", async () => {
    const result = await callMcpOperation("listMemory", { cwd: "/etc" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Path not allowed");
  });

  it("runs listMemory against the real SDK", async () => {
    await addMemory({ cwd: dir, kind: "pinned-package", package: "left-pad", reason: "legacy" });
    const result = await callMcpOperation("listMemory", { cwd: dir, kind: "pinned-package" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      path: ".autoremediator/memory.md",
      exists: true,
      counts: { active: 1, proposed: 0, expired: 0, total: 1 },
      entries: [{ kind: "pinned-package", package: "left-pad", state: "active" }],
    });
  });
});

describe("the MCP server", () => {
  it("lists and reads the memory resource, with active entries only", async () => {
    await addMemory({ cwd: dir, kind: "test-command", command: "npm run test:unit" });
    await addMemory({
      cwd: dir,
      kind: "note",
      text: "a proposal",
      status: "proposed",
      source: "agent",
    });
    await addMemory({
      cwd: dir,
      kind: "note",
      text: "lapsed",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const client = await connect();

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toContain("autoremediator://memory");

    const body = JSON.parse(
      (
        (await client.readResource({ uri: "autoremediator://memory" })).contents[0] as {
          text: string;
        }
      ).text,
    );
    expect(body.entries).toMatchObject([{ kind: "test-command", command: "npm run test:unit" }]);
    expect(body.note).toMatch(/not instructions/);
    expect(JSON.stringify(body)).not.toContain("a proposal");
    expect(JSON.stringify(body)).not.toContain("lapsed");
  });

  it("reads as empty when the repository remembers nothing", async () => {
    const client = await connect();
    const body = JSON.parse(
      (
        (await client.readResource({ uri: "autoremediator://memory" })).contents[0] as {
          text: string;
        }
      ).text,
    );
    expect(body.entries).toEqual([]);
    expect(body.problem).toBeUndefined();
  });

  it("serves listMemory over the wire, validated against its output schema", async () => {
    await addMemory({ cwd: dir, kind: "install-quirk", text: "needs python3" });
    const client = await connect();
    const result = await client.callTool({ name: "listMemory", arguments: { cwd: dir } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ counts: { active: 1 } });

    const writer = await client.callTool({
      name: "addMemory",
      arguments: { kind: "note", text: "x" },
    });
    expect(writer.isError).toBe(true);
  });
});
