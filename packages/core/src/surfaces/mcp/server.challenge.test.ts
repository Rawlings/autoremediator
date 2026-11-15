import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createMcpServer, TOOLS } from "./server.js";

describe("Milestone 4 Challenge: MCP Server Edge Conditions & Error Propagation", () => {
  it("handles unknown tool calls gracefully with isError: true and informative message", async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result = await client.callTool({
      name: "completely_unknown_tool",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Unknown tool: completely_unknown_tool");

    await client.close();
    await server.close();
  });

  it("handles missing required arguments with isError: true without throwing", async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // 1. checkReachability without packageName
    const r1 = await client.callTool({
      name: "checkReachability",
      arguments: {},
    });
    expect(r1.isError).toBe(true);
    expect((r1.content as any)[0].text).toContain("packageName is required");

    // 2. evaluatePackage without packageName
    const r2 = await client.callTool({
      name: "evaluatePackage",
      arguments: { packageName: 123 as any },
    });
    expect(r2.isError).toBe(true);
    expect((r2.content as any)[0].text).toContain("packageName is required");

    // 3. toVex without valid report object
    const r3 = await client.callTool({
      name: "toVex",
      arguments: { report: "not-an-object" as any },
    });
    expect(r3.isError).toBe(true);
    expect((r3.content as any)[0].text).toContain("report is required");

    await client.close();
    await server.close();
  });

  it("captures thrown exceptions in underlying tool execution with isError: true without crashing connection", async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Call pollJob with non-existent jobId (which causes pollJob to throw an Error)
    const result = await client.callTool({
      name: "pollJob",
      arguments: { jobId: "non-existent-job-id" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain("Job not found");

    // Verify the MCP server is still alive and responsive after error
    const ping = await client.callTool({
      name: "health",
      arguments: {},
    });
    expect(ping.isError).toBeUndefined();
    expect((ping.content as any)[0].text).toContain('"status": "ok"');

    await client.close();
    await server.close();
  });

  it("verifies all registered MCP tools declare name and description", () => {
    expect(TOOLS.length).toBeGreaterThan(10);
    for (const tool of TOOLS) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
    }
  });
});
