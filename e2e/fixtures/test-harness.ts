import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface NodeScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runNodeScript(
  scriptPath: string,
  args: string[] = [],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<NodeScriptResult> {
  return new Promise((resolve) => {
    const { cwd = process.cwd(), timeoutMs = 15_000 } = options;
    const isTs = scriptPath.endsWith(".ts");
    const nodeArgs = isTs ? ["--experimental-strip-types", scriptPath, ...args] : [scriptPath, ...args];

    let timedOut = false;
    const child = spawn("node", nodeArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? (timedOut ? 143 : 1),
        stdout,
        stderr,
        timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: err.message,
        timedOut: false,
      });
    });
  });
}

export function createReproductionScript(
  dir: string,
  kind: "vulnerable" | "patched" | "syntax-error" | "timeout",
): string {
  const filePath = join(dir, "reproduce.js");
  let content = "";

  switch (kind) {
    case "vulnerable":
      // Fails assertion on unpatched code (exit 1)
      content = `
import assert from "node:assert";
import { vulnerableFunction } from "./target.js";
assert.strictEqual(vulnerableFunction("test"), "sanitized", "Exploit reproduced: unsanitized input");
`;
      break;

    case "patched":
      // Passes on patched code (exit 0)
      content = `
import assert from "node:assert";
import { vulnerableFunction } from "./target.js";
assert.strictEqual(vulnerableFunction("test"), "sanitized");
console.log("Proof-of-fix passed");
`;
      break;

    case "syntax-error":
      // Malformed syntax (harness error)
      content = `
import assert from "node:assert";
const invalid = ; // syntax error
`;
      break;

    case "timeout":
      // Infinite loop / sleep beyond timeout
      content = `
setInterval(() => {}, 100000);
`;
      break;
  }

  writeFileSync(filePath, content.trim(), "utf8");
  return filePath;
}

export function createOfflineSnapshot(dir: string, data: Record<string, unknown>): string {
  const filePath = join(dir, "snapshot.json");
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}
