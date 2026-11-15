import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { persistPlan } from "../../features/runs/index.js";
import { type ApiDeps, defaultApiDeps } from "../catalog/index.js";
import { createMcpHttpServer, requiredRole } from "./http.js";

let dir: string;
let server: ReturnType<typeof createMcpHttpServer>;
let url: string;
let deps: ApiDeps;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-http-")));
  writeFileSync(join(dir, "package.json"), '{"name":"app"}');
  vi.stubEnv("AUTOREMEDIATOR_ALLOWED_ROOTS", dir);
  vi.stubEnv("AUTOREMEDIATOR_API_TOKENS", "admin:adm,operator:opr,reader:rdr");
  deps = {
    ...defaultApiDeps,
    applyPlanFn: vi.fn(async () => ({
      runId: "run_x",
      status: "applied",
      items: [],
      pending: [],
      skipped: [],
      message: "ok",
      cwd: dir,
    })),
  } as unknown as ApiDeps;
  server = createMcpHttpServer({ deps, projectDir: dir });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => {
    server.close(resolve);
  });
  rmSync(dir, { recursive: true, force: true });
});

const rpc = (
  method: string,
  params: object = {},
  headers: Record<string, string> = {},
  id: number | undefined = 1,
) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
  });

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const call = (name: string, args: object, token?: string) =>
  rpc("tools/call", { name, arguments: args }, token ? bearer(token) : {});

async function client(token: string) {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: bearer(token) } }),
  );
  return c;
}

describe("requiredRole", () => {
  it("is reader for everything except tool calls, which need the tool's own role", () => {
    expect(requiredRole({ method: "initialize" }).role).toBe("reader");
    expect(requiredRole({ method: "resources/read", params: { uri: "x" } }).role).toBe("reader");
    expect(requiredRole({ method: "tools/call", params: { name: "getRun" } }).role).toBe("reader");
    expect(requiredRole({ method: "tools/call", params: { name: "abandonAttempt" } }).role).toBe(
      "operator",
    );
    expect(requiredRole({ method: "tools/call", params: { name: "startAttempt" } }).role).toBe(
      "admin",
    );
    expect(requiredRole({ method: "tools/call", params: { name: "applyPlan" } })).toEqual({
      role: "admin",
      label: "tool applyPlan",
    });
    expect(requiredRole({ method: "tools/call", params: { name: "nope" } }).role).toBe("reader");
  });

  it("takes the strongest role in a batch", () => {
    expect(
      requiredRole([
        { method: "tools/call", params: { name: "getRun" } },
        { method: "tools/call", params: { name: "rollbackRun" } },
      ]).role,
    ).toBe("admin");
  });
});

describe("MCP over HTTP", () => {
  it("serves a real client: tools, structured results, resources and prompts", async () => {
    const c = await client("rdr");
    const { tools } = await c.listTools();
    expect(tools.map((tool) => tool.name)).toContain("applyPlan");

    const { runId } = await persistPlan(
      { cveId: "CVE-1", cveDetails: null, vulnerablePackages: [], summary: "", results: [] },
      {},
      dir,
    );
    const run = await c.callTool({ name: "getRun", arguments: { runId, cwd: dir } });
    expect(run.structuredContent).toMatchObject({ run: { runId } });
    expect((await c.listResources()).resources.map((resource) => resource.uri)).toContain(
      `autoremediator://runs/${runId}`,
    );
    expect((await c.listPrompts()).prompts).toHaveLength(3);
    await c.close();
  });

  it("lets each role do what its tools need and nothing more", async () => {
    const runId = "run_aaaaaaaaaaaaaaaaaaaa";
    const apply = { runId, cwd: dir };

    expect((await call("applyPlan", apply, "rdr")).status).toBe(403);
    expect((await call("applyPlan", apply, "opr")).status).toBe(403);
    expect(deps.applyPlanFn).not.toHaveBeenCalled();

    const allowed = await call("applyPlan", apply, "adm");
    expect(allowed.status).toBe(200);
    expect(deps.applyPlanFn).toHaveBeenCalledTimes(1);
    // A read tool is open to a reader (here it fails on the missing run, but it is let through).
    expect((await call("getRun", { runId, cwd: dir }, "rdr")).status).toBe(200);
  });

  it("requires a valid token, and a configured way to check one", async () => {
    expect((await call("getRun", {})).status).toBe(401);
    expect((await call("getRun", {}, "wrong")).status).toBe(401);

    vi.stubEnv("AUTOREMEDIATOR_API_TOKENS", "");
    vi.stubEnv("AUTOREMEDIATOR_JWT_SECRET", "");
    expect((await call("getRun", {})).status).toBe(503);
    vi.stubEnv("AUTOREMEDIATOR_INSECURE_NO_AUTH", "1");
    expect((await call("getRun", {})).status).toBe(200);
  });

  it("is stateless: no session header is issued or needed", async () => {
    const first = await rpc("tools/list", {}, bearer("rdr"));
    expect(first.status).toBe(200);
    expect(first.headers.get("mcp-session-id")).toBeNull();
    const second = await rpc("tools/list", {}, bearer("rdr"));
    expect(second.status).toBe(200);
  });

  it("rejects what it should: other paths and methods, foreign hosts, bad bodies", async () => {
    expect((await fetch(url.replace("/mcp", "/other"), { method: "POST" })).status).toBe(404);
    const get = await fetch(url, { headers: bearer("adm") });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");

    // `fetch` will not send a made-up Host header, so use a raw request.
    const foreign = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Host: "evil.example", ...bearer("adm") },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(foreign).toBe(403);
    const text = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain", ...bearer("adm") },
      body: "{}",
    });
    expect(text.status).toBe(415);
    const broken = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer("adm") },
      body: "{nope",
    });
    expect(broken.status).toBe(400);
  });

  it("confines path arguments the same way the other transports do", async () => {
    const response = await call("listRuns", { cwd: "/etc" }, "rdr");
    const body = (await response.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toMatch(/Path not allowed/);
  });
});

describe("the built server in HTTP mode", () => {
  it("starts from the real entry point and answers a request", async () => {
    const { spawn } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const entry = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../dist/surfaces/mcp/server.js",
    );
    expect(existsSync(entry), "run `pnpm build` first").toBe(true);

    // A free port: bind to 0, read it, release it.
    const probe = (await import("node:net")).createServer();
    await new Promise<void>((resolve) => {
      probe.listen(0, "127.0.0.1", resolve);
    });
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => {
      probe.close(resolve);
    });

    const proc = spawn(process.execPath, [entry, "--http", "--port", String(port)], {
      env: { ...process.env, AUTOREMEDIATOR_API_TOKENS: "reader:rdr" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the HTTP server did not start")), 10_000);
        proc.stderr.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("listening")) {
            clearTimeout(timer);
            resolve();
          }
        });
        proc.on("exit", (code) => reject(new Error(`the HTTP server exited with ${code}`)));
      });

      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer rdr",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
      expect(body.result.tools.map((tool) => tool.name)).toContain("startAttempt");
    } finally {
      proc.kill();
    }
  });
});
