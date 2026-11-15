import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PLATFORM_INJECTED_ENV,
  runSandboxed,
  SANDBOX_ENV,
  type SandboxResult,
  verifySandbox,
} from "./sandbox.js";

/**
 * These run hostile scripts straight through the sandbox, with the static screen out of the way:
 * the screen is a tripwire, the sandbox is the boundary, and this is the test of the boundary.
 */

let root: string;
let outside: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-test-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-outside-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const run = (
  script: string,
  over: Partial<{ timeoutMs: number; maxOutputBytes: number }> = {},
): Promise<SandboxResult> => {
  writeFileSync(join(root, "s.cjs"), script, "utf8");
  return runSandboxed({
    dir: root,
    script: "s.cjs",
    timeoutMs: 8000,
    maxOutputBytes: 64 * 1024,
    ...over,
  });
};

const outcomeOf = (result: SandboxResult): Record<string, string> =>
  JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, string>;

describe("verifySandbox", () => {
  it("shows, by trying each one from inside, that the things it claims to refuse are refused", async () => {
    const report = await verifySandbox();
    expect(report.denied).toEqual(
      expect.arrayContaining([
        "network-connect",
        "dns-lookup",
        "child-process",
        "read-outside-dir",
        "write-outside-dir",
        "signal-all-processes",
      ]),
    );
    expect(report.notLimited.join(" ")).toContain("CPU time");
    expect(report.node).toBe(process.version);
  });
});

describe("a hostile script is contained", () => {
  it("cannot read the home directory, system files or a file beside its directory, and sees none of the caller's environment", async () => {
    process.env["PROOF_TEST_SECRET"] = "hunter2";
    try {
      writeFileSync(join(outside, "secret.txt"), "top secret");
      const result = await run(`
        const fs = require("node:fs");
        const os = require("node:os");
        const out = {};
        const attempt = (name, fn) => { try { fn(); out[name] = "ALLOWED"; } catch (e) { out[name] = e.code; } };
        attempt("home", () => fs.readdirSync(os.homedir()));
        attempt("etc", () => fs.readFileSync("/etc/hosts"));
        attempt("sibling", () => fs.readFileSync(${JSON.stringify(join(outside, "secret.txt"))}));
        out.env = Object.keys(process.env).sort();
        console.log(JSON.stringify(out));
      `);
      const out = outcomeOf(result) as unknown as Record<string, unknown>;
      expect(out["home"]).toBe("ERR_ACCESS_DENIED");
      expect(out["etc"]).toBe("ERR_ACCESS_DENIED");
      expect(out["sibling"]).toBe("ERR_ACCESS_DENIED");
      expect(
        (out["env"] as unknown as string[]).filter((name) => !PLATFORM_INJECTED_ENV.has(name)),
      ).toEqual(Object.keys(SANDBOX_ENV).toSorted());
      expect(result.stdout).not.toContain("hunter2");
      expect(result.stdout).not.toContain("top secret");
    } finally {
      delete process.env["PROOF_TEST_SECRET"];
    }
  });

  it("cannot write, inside its directory or outside it", async () => {
    const target = join(outside, "planted.txt");
    const result = await run(`
      const fs = require("node:fs");
      const out = {};
      const attempt = (name, fn) => { try { fn(); out[name] = "ALLOWED"; } catch (e) { out[name] = e.code; } };
      attempt("inside", () => fs.writeFileSync(__dirname + "/planted.txt", "x"));
      attempt("outside", () => fs.writeFileSync(${JSON.stringify(target)}, "x"));
      attempt("mkdir", () => fs.mkdirSync(${JSON.stringify(join(outside, "d"))}));
      console.log(JSON.stringify(out));
    `);
    expect(outcomeOf(result)).toEqual({
      inside: "ERR_ACCESS_DENIED",
      outside: "ERR_ACCESS_DENIED",
      mkdir: "ERR_ACCESS_DENIED",
    });
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(root, "planted.txt"))).toBe(false);
  });

  describe("network", () => {
    let server: Server;
    let connections = 0;
    let port = 0;
    beforeEach(async () => {
      connections = 0;
      server = createServer((socket) => {
        connections += 1;
        socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi");
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      port = (server.address() as { port: number }).port;
    });
    afterEach(() => {
      server.close();
    });

    it("cannot reach a listening local server by socket, fetch, http or DNS", async () => {
      const result = await run(`
        const out = {};
        const attempt = async (name, fn) => { try { await fn(); out[name] = "ALLOWED"; } catch (e) { out[name] = e.code || (e.cause && e.cause.code) || e.message; } };
        (async () => {
          await attempt("net", () => new Promise((res, rej) => { const s = require("node:net").connect(${port}, "127.0.0.1"); s.on("connect", res); s.on("error", rej); }));
          await attempt("fetch", () => fetch("http://127.0.0.1:${port}/"));
          await attempt("http", () => new Promise((res, rej) => require("node:http").get("http://127.0.0.1:${port}/", res).on("error", rej)));
          await attempt("dns", () => require("node:dns").promises.lookup("example.com"));
          console.log(JSON.stringify(out));
        })();
      `);
      expect(outcomeOf(result)).toEqual({
        net: "ERR_ACCESS_DENIED",
        fetch: "ERR_ACCESS_DENIED",
        http: "ERR_ACCESS_DENIED",
        dns: "ERR_ACCESS_DENIED",
      });
      expect(connections).toBe(0);
    });
  });

  it("cannot start a process, however it asks (and a fork-bomb loop starts nothing)", async () => {
    const marker = join(outside, "marker");
    const result = await run(`
      const cp = require("node:child_process");
      const out = { attempts: 0, started: 0 };
      for (let i = 0; i < 200; i++) {
        out.attempts++;
        for (const call of [
          () => cp.spawnSync(process.execPath, ["-e", ${JSON.stringify(`require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`)}]),
          () => cp.execSync(${JSON.stringify(`touch ${marker}`)}),
          () => cp.fork(__filename),
          () => new (require("node:worker_threads").Worker)("1", { eval: true }),
        ]) {
          try { call(); out.started++; } catch (e) { out.code = e.code; }
        }
      }
      console.log(JSON.stringify(out));
    `);
    expect(result.stderr).toBe("");
    const out = JSON.parse(result.stdout.trim()) as {
      attempts: number;
      started: number;
      code: string;
    };
    expect(out).toEqual({ attempts: 200, started: 0, code: "ERR_ACCESS_DENIED" });
    expect(existsSync(marker)).toBe(false);
  });

  describe("signals", () => {
    let victim: ChildProcess;
    beforeEach(() => {
      victim = spawn("sleep", ["60"], { stdio: "ignore" });
    });
    afterEach(() => {
      victim.kill("SIGKILL");
    });

    it("cannot signal any process but itself: not a named one, not the parent, not every one", async () => {
      const result = await run(`
        const out = {};
        const attempt = (name, fn) => { try { fn(); out[name] = "SENT"; } catch (e) { out[name] = e.code; } };
        attempt("kill-named", () => process.kill(${victim.pid}, "SIGKILL"));
        attempt("_kill-named", () => process._kill(${victim.pid}, 9));
        attempt("kill-parent", () => process.kill(process.ppid, 0));
        attempt("kill-all", () => process.kill(-1, 0));
        attempt("kill-group", () => process.kill(0, 0));
        attempt("redefine", () => Object.defineProperty(process, "kill", { value: () => {} }));
        console.log(JSON.stringify(out));
      `);
      const out = outcomeOf(result);
      expect(out["kill-named"]).toBe("ERR_ACCESS_DENIED");
      expect(out["_kill-named"]).toBe("ERR_ACCESS_DENIED");
      expect(out["kill-parent"]).toBe("ERR_ACCESS_DENIED");
      expect(out["kill-all"]).toBe("ERR_ACCESS_DENIED");
      expect(out["kill-group"]).toBe("ERR_ACCESS_DENIED");
      expect(out["redefine"]).toBeUndefined();
      // The sacrificial process is still there.
      expect(() => process.kill(victim.pid!, 0)).not.toThrow();
    });
  });

  it("is killed when it loops forever", async () => {
    const result = await run("while (true) {}", { timeoutMs: 700 });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.durationMs).toBeLessThan(5000);
  });

  it("is killed when it floods its output, and what it said is capped", async () => {
    const result = await run(
      `
      const chunk = "x".repeat(8192);
      const flood = () => { process.stdout.write(chunk); setImmediate(flood); };
      flood();
    `,
      { maxOutputBytes: 32 * 1024 },
    );
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(32 * 1024);
    expect(result.durationMs).toBeLessThan(8000);
  });

  it("is killed by the timeout when it floods its output without ever yielding (a pipe holds 64 KiB, then the writes pile up in its own memory)", async () => {
    const result = await run(
      `
      const chunk = "x".repeat(8192);
      for (;;) process.stdout.write(chunk);
    `,
      { timeoutMs: 700 },
    );
    expect(result.timedOut || result.outputLimitExceeded).toBe(true);
    expect(result.durationMs).toBeLessThan(5000);
  });

  it("is killed when it exhausts the heap, and does not take the caller down", async () => {
    const result = await run(`
      const hoard = [];
      while (true) hoard.push(new Array(1e6).fill({ a: 1 }));
    `);
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("does not leave a process behind when it ends", async () => {
    const result = await run(`console.log(process.pid);`);
    const pid = Number(result.stdout.trim());
    expect(Number.isInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("runs an honest script and reports its exit code and output", async () => {
    const result = await run(`
      const assert = require("node:assert");
      console.error("EXPLOIT_REPRODUCED: demo");
      process.exit(1);
    `);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("EXPLOIT_REPRODUCED: demo");
    expect(readFileSync(join(root, "s.cjs"), "utf8")).toContain("EXPLOIT_REPRODUCED");
  });
});
