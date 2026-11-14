/** The MCP surface as a client sees it: structured results, resources, prompts and confirmation. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { persistPlan } from "../api/runs/index.js";
import type { ApiDeps } from "../catalog/index.js";
import { RunStore } from "../runs/run-store.js";
import { createMcpServer, type McpServerOptions } from "./server.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-proto-")));
  writeFileSync(join(dir, "package.json"), '{"name":"app"}');
  vi.stubEnv("AUTOREMEDIATOR_ALLOWED_ROOTS", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function connect(options: McpServerOptions = {}, elicit?: (message: string) => "accept" | "decline" | "cancel") {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ projectDir: dir, ...options });
  const client = new Client({ name: "test", version: "0" }, { capabilities: elicit ? { elicitation: {} } : {} });
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const action = elicit(request.params.message);
      return action === "accept" ? { action, content: { proceed: true } } : { action };
    });
  }
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const preview = {
  cveId: "CVE-2021-0001",
  cveDetails: null,
  vulnerablePackages: [],
  summary: "preview",
  results: [{ packageName: "dep", strategy: "version-bump" as const, fromVersion: "1.0.0", toVersion: "2.0.0", applied: false, dryRun: true, message: "planned", dependencyScope: "direct" as const }],
};

describe("structured tool results", () => {
  it("declares an output schema for every tool", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(25);
    for (const tool of tools) {
      expect([tool.name, tool.outputSchema?.["type"]]).toEqual([tool.name, "object"]);
      expect([tool.name, tool.annotations !== undefined]).toEqual([tool.name, true]);
    }
  });

  it("returns structured content that satisfies the declared schema (the client checks it)", async () => {
    const client = await connect();
    await client.listTools();

    const health = await client.callTool({ name: "health", arguments: {} });
    expect(health.isError).toBeUndefined();
    expect(health.structuredContent).toMatchObject({ status: "ok" });

    const { runId } = await persistPlan(preview, {}, dir);
    const run = await client.callTool({ name: "getRun", arguments: { runId, cwd: dir } });
    expect(run.isError).toBeUndefined();
    expect(run.structuredContent).toMatchObject({ run: { runId, status: "planned" } });
  });

  it("wraps list results as { items } and keeps the text a plain array", async () => {
    const client = await connect();
    await client.listTools();
    await persistPlan(preview, {}, dir);

    const result = await client.callTool({ name: "listRuns", arguments: { cwd: dir } });

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { items: unknown[] }).items).toHaveLength(1);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(Array.isArray(JSON.parse(text))).toBe(true);
  });

  it("does not claim structured content for an error", async () => {
    const client = await connect();
    await client.listTools();
    const result = await client.callTool({ name: "getRun", arguments: { runId: "nope" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});

describe("resources", () => {
  it("lists the project's runs and the templates for reading them", async () => {
    const client = await connect();
    const { runId } = await persistPlan(preview, {}, dir);

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining(["autoremediator://runs", "autoremediator://policy", `autoremediator://runs/${runId}`]),
    );
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate)).toContain(
      "autoremediator://runs/{runId}/attempts/{attemptId}/diff",
    );
  });

  it("reads a run, its plan and its ledger", async () => {
    const client = await connect();
    const { runId, planId } = await persistPlan(preview, {}, dir);
    const read = async (uri: string) => JSON.parse(((await client.readResource({ uri })).contents[0] as { text: string }).text);

    expect((await read(`autoremediator://runs/${runId}`)).run).toMatchObject({ runId, planId });
    expect((await read(`autoremediator://runs/${runId}/plan`)).items).toHaveLength(1);
    expect((await read(`autoremediator://runs/${runId}/steps`)).ok).toBe(true);
    await expect(read("autoremediator://runs")).resolves.toHaveLength(1);
  });

  it("reads an attempt's patch and verification, and the policy", async () => {
    const client = await connect();
    const { runId } = await persistPlan(preview, {}, dir);
    new RunStore(dir).writeAttempt(
      runId,
      { attemptId: "attempt_aaaaaaaaaaaa", itemId: "item_aaaaaaaaaaaa", agentId: "host", status: "rejected", reason: "x", rounds: 1, changedFiles: [], startedAt: "t", endedAt: "t" },
      { "diff.patch": "diff --git a/x b/x\n", "verification.json": '{"passed":false}\n' },
    );
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github/autoremediator.yml"), "allowMajorBumps: true\n");

    const base = `autoremediator://runs/${runId}/attempts/attempt_aaaaaaaaaaaa`;
    expect((await client.readResource({ uri: `${base}/diff` })).contents[0]).toMatchObject({ mimeType: "text/x-diff", text: "diff --git a/x b/x\n" });
    expect((await client.readResource({ uri: `${base}/verification` })).contents[0]).toMatchObject({ mimeType: "application/json" });
    await expect(client.readResource({ uri: `${base}/transcript` })).rejects.toThrow(/no transcript/);
    expect((await client.readResource({ uri: "autoremediator://policy" })).contents[0]).toMatchObject({ text: "allowMajorBumps: true\n" });
  });

  it("refuses anything that is not a well-formed resource id", async () => {
    const client = await connect();
    for (const uri of [
      "autoremediator://runs/../../etc/passwd",
      "autoremediator://runs/run_short",
      "autoremediator://runs/run_aaaaaaaaaaaaaaaaaaaa/../../x",
      "autoremediator://elsewhere",
      "file:///etc/passwd",
    ]) {
      await expect(client.readResource({ uri })).rejects.toThrow(/Unknown resource/);
    }
    await expect(client.readResource({ uri: "autoremediator://runs/run_aaaaaaaaaaaaaaaaaaaa" })).rejects.toThrow(/not found/);
  });
});

describe("prompts", () => {
  it("lists the guided flows and builds them from valid arguments", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).toSorted()).toEqual(["remediate-cve", "repair-upgrade", "review-run"]);

    const remediate = await client.getPrompt({ name: "remediate-cve", arguments: { cveId: "CVE-2021-23337" } });
    const text = (remediate.messages[0]!.content as { text: string }).text;
    for (const tool of ["planRemediation", "applyPlan", "startAttempt", "finalizeAttempt", "verifyRun", "rollbackRun"]) {
      expect(text).toContain(tool);
    }
    expect(text).toContain("CVE-2021-23337");

    const repair = await client.getPrompt({ name: "repair-upgrade", arguments: { runId: "run_aaaaaaaaaaaaaaaaaaaa", itemId: "item_0123456789ab" } });
    expect((repair.messages[0]!.content as { text: string }).text).toContain("abandonAttempt");
  });

  it("rejects missing or malformed arguments, and unknown prompts", async () => {
    const client = await connect();
    await expect(client.getPrompt({ name: "remediate-cve", arguments: { cveId: "not a cve; rm -rf /" } })).rejects.toThrow(/cveId is required/);
    await expect(client.getPrompt({ name: "review-run", arguments: {} })).rejects.toThrow(/runId is required/);
    await expect(client.getPrompt({ name: "nope" })).rejects.toThrow(/Unknown prompt/);
  });
});

describe("confirming changes with the user", () => {
  const fakeDeps = () =>
    ({
      applyPlanFn: vi.fn(async () => ({ runId: "run_x", status: "applied", items: [], pending: [], skipped: [], message: "ok", cwd: dir })),
      getRunFn: vi.fn(() => ({ run: {} })),
    }) as unknown as ApiDeps;
  const runId = "run_aaaaaaaaaaaaaaaaaaaa";

  it("asks before a tool that changes the project, and proceeds when told to", async () => {
    const asked: string[] = [];
    const deps = fakeDeps();
    const client = await connect({ deps, confirm: "mutating" }, (message) => (asked.push(message), "accept"));

    const result = await client.callTool({ name: "applyPlan", arguments: { runId, cwd: dir } });

    expect(result.isError).toBeUndefined();
    expect(deps.applyPlanFn).toHaveBeenCalledTimes(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/Apply a plan \(runId run_a+, cwd .*\)\. This can change files/);
  });

  it("does nothing when the user declines or cancels", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const deps = fakeDeps();
      const client = await connect({ deps, confirm: "mutating" }, () => action);
      const result = await client.callTool({ name: "applyPlan", arguments: { runId, cwd: dir } });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/declined by the user; nothing was changed/);
      expect(deps.applyPlanFn).not.toHaveBeenCalled();
    }
  });

  it("does not ask for read-only tools", async () => {
    const asked: string[] = [];
    const deps = fakeDeps();
    const client = await connect({ deps, confirm: "mutating" }, (message) => (asked.push(message), "accept"));
    await client.callTool({ name: "getRun", arguments: { runId, cwd: dir } });
    expect(asked).toEqual([]);
    expect(deps.getRunFn).toHaveBeenCalled();
  });

  it("refuses, rather than trusting, a client that cannot be asked", async () => {
    const deps = fakeDeps();
    const client = await connect({ deps, confirm: "mutating" });
    const result = await client.callTool({ name: "applyPlan", arguments: { runId, cwd: dir } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/cannot ask/);
    expect(deps.applyPlanFn).not.toHaveBeenCalled();
  });

  it("is off by default: the host's own approval for destructive tools applies", async () => {
    const asked: string[] = [];
    const deps = fakeDeps();
    const client = await connect({ deps }, (message) => (asked.push(message), "accept"));
    await client.callTool({ name: "applyPlan", arguments: { runId, cwd: dir } });
    expect(asked).toEqual([]);
    expect(deps.applyPlanFn).toHaveBeenCalled();
  });
});
