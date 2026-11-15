import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sleep } from "../../shared/time.js";
import { runProcess, sanitizeOutput } from "./shell.js";

/**
 * Whether a process has exited, given a moment. Killing a tree is not instant: the kernel still
 * lists the process for a short while after the signal is delivered, longest on a busy CI runner.
 */
async function isGoneSoon(pid: number, withinMs = 3000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(50);
  }
  return false;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shell-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("runProcess", () => {
  it("returns the exit code and the combined output of a shell command", async () => {
    const result = await runProcess({
      shell: "echo out; echo err 1>&2; exit 7",
      cwd: dir,
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(7);
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
    expect(result.timedOut).toBe(false);
  });

  it("runs an argv without a shell, so metacharacters are plain arguments", async () => {
    const result = await runProcess({
      argv: ["node", "-p", "process.argv[1]", "a; echo injected"],
      cwd: dir,
      timeoutMs: 10_000,
    });
    expect(result.output.trim()).toBe("a; echo injected");
  });

  it("kills the whole process tree on timeout", async () => {
    const pidFile = join(dir, "child.pid");
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const result = await runProcess({
      shell: `node -e ${JSON.stringify(script)} & wait`,
      cwd: dir,
      timeoutMs: 1000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(10_000);
    await expect(isGoneSoon(Number(readFileSync(pidFile, "utf8")))).resolves.toBe(true);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    const pending = runProcess({
      shell: "sleep 30",
      cwd: dir,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it("reports a program that cannot be started as exit code 127", async () => {
    const result = await runProcess({
      argv: ["definitely-not-a-program-xyz"],
      cwd: dir,
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(127);
    expect(result.output).toContain("could not start");
  });

  it("keeps only the end of very long output", async () => {
    const result = await runProcess({
      argv: ["node", "-e", "process.stdout.write('x'.repeat(5000) + 'END')"],
      cwd: dir,
      timeoutMs: 10_000,
      keepBytes: 100,
    });
    expect(result.output.length).toBeLessThanOrEqual(5003);
    expect(result.output.endsWith("END")).toBe(true);
  });
});

describe("sanitizeOutput", () => {
  it("removes terminal escapes", () => {
    expect(sanitizeOutput("\u001B[31mred\u001B[0m text")).toBe("red text");
  });

  it("redacts credentials by shape and by environment variable", () => {
    const text = [
      "token npm_abcdefghijklmnopqrstuvwxyz0123",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "//registry.example.test/:_authToken=secretvalue123",
      "Authorization: Bearer abcdefghijklmnop.qrstuv",
      "clone https://user:hunter2@example.test/repo.git",
      "from env: s3cr3t-value-from-env",
    ].join("\n");
    const out = sanitizeOutput(text, {
      env: { MY_API_TOKEN: "s3cr3t-value-from-env", SHORT_TOKEN: "abc", PATH: "/usr/bin" },
    });
    expect(out).not.toMatch(
      /npm_abc|ghp_abc|secretvalue123|abcdefghijklmnop\.|hunter2|s3cr3t-value/,
    );
    expect(out).toContain("https://[redacted]@example.test/repo.git");
    expect(out.split("[redacted]").length).toBeGreaterThanOrEqual(6);
  });

  it("shortens checkout and home paths", () => {
    const out = sanitizeOutput("error at /tmp/wt-123/src/x.js:4", {
      paths: [["/tmp/wt-123", "<checkout>"]],
      env: {},
    });
    expect(out).toBe("error at <checkout>/src/x.js:4");
  });

  it("keeps the last characters, starting at a line boundary", () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
    const out = sanitizeOutput(lines, { maxChars: 100, env: {} });
    expect(out.startsWith("...")).toBe(true);
    expect(out.endsWith("line 199")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(104);
  });
});
