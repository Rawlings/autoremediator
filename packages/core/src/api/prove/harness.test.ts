import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SandboxResult } from "../../platform/sandbox.js";
import { createHarness, type Harness } from "./harness.js";

/** A package with one function, `sanitize`, that the vulnerable version leaves unescaped. */
const VULNERABLE = `exports.sanitize = (input) => String(input);\nexports.version = "1.0.0";\n`;
const FIXED = `exports.sanitize = (input) => String(input).replaceAll("<", "&lt;").replaceAll(">", "&gt;");\nexports.version = "1.0.1";\n`;

let root: string;
let harness: Harness;

function install(dir: string, source: string): void {
  const pkg = join(dir, "node_modules", "fakepkg");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fakepkg", main: "index.js" }));
  writeFileSync(join(pkg, "index.js"), source);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harness-test-")));
  mkdirSync(join(root, "v"));
  mkdirSync(join(root, "f"));
  install(join(root, "v"), VULNERABLE);
  install(join(root, "f"), FIXED);
  harness = createHarness({
    packageName: "fakepkg",
    vulnerableVersion: "1.0.0",
    fixedVersion: "1.0.1",
    vulnerableDir: join(root, "v"),
    fixedDir: join(root, "f"),
    timeoutMs: 1500,
    maxOutputBytes: 32 * 1024,
  });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const GOOD = `
const assert = require("node:assert");
const { sanitize } = require("fakepkg");
assert.strictEqual(sanitize("<script>"), "&lt;script&gt;");
`;

describe("the harness", () => {
  it("accepts a script that fails on the vulnerable version and passes on the fixed one", async () => {
    const result = await harness.prove(GOOD);
    expect(result).toMatchObject({ accepted: true, stage: "confirmed" });
    expect(result.vulnerableRun).toMatchObject({ verdict: "reproduced", exitCode: 1 });
    expect(result.vulnerableRun?.outputTail).toContain("AssertionError");
    expect(result.vulnerableRun?.outputTail).not.toContain(root);
    expect(result.fixedRun).toMatchObject({ verdict: "clean", exitCode: 0 });
    expect(result.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts an explicit EXPLOIT_REPRODUCED exit, the form the existing proof-of-fix check also accepts", async () => {
    const result = await harness.prove(`
      const { sanitize } = require("fakepkg");
      if (sanitize("<b>") === "<b>") { console.error("EXPLOIT_REPRODUCED: markup passes through"); process.exit(1); }
    `);
    expect(result.accepted).toBe(true);
  });

  it("rejects a script that fails on both versions: it does not tell them apart", async () => {
    const result = await harness.prove(`
      const assert = require("node:assert");
      const { sanitize } = require("fakepkg");
      assert.strictEqual(sanitize("a"), "not what anything returns");
    `);
    expect(result).toMatchObject({ accepted: false, stage: "fixed" });
    expect(result.vulnerableRun?.verdict).toBe("reproduced");
    expect(result.fixedRun?.verdict).toBe("still-failing");
    expect(result.reason).toContain("also fails on the fixed version");
  });

  it("rejects a script that passes on both versions: it detects nothing", async () => {
    const result = await harness.prove(`
      const assert = require("node:assert");
      const { sanitize } = require("fakepkg");
      assert.strictEqual(typeof sanitize, "function");
    `);
    expect(result).toMatchObject({ accepted: false, stage: "vulnerable" });
    expect(result.vulnerableRun?.verdict).toBe("no-reproduction");
    expect(result.fixedRun).toBeUndefined();
  });

  it("rejects a script that crashes on the vulnerable version instead of asserting", async () => {
    const result = await harness.prove(`
      const { sanitize } = require("fakepkg");
      sanitize.doesNotExist();
    `);
    expect(result.accepted).toBe(false);
    expect(result.vulnerableRun?.verdict).toBe("crashed");
  });

  it("rejects a script that exits 1 without saying why (not an assertion)", async () => {
    const result = await harness.prove(`require("fakepkg"); process.exit(1);`);
    expect(result.vulnerableRun?.verdict).toBe("crashed");
    expect(result.accepted).toBe(false);
  });

  it("rejects a script whose result is not repeatable", async () => {
    let call = 0;
    const flaky = createHarness({
      packageName: "fakepkg",
      vulnerableVersion: "1.0.0",
      fixedVersion: "1.0.1",
      vulnerableDir: join(root, "v"),
      fixedDir: join(root, "f"),
      timeoutMs: 1500,
      maxOutputBytes: 1024,
      run: async (): Promise<SandboxResult> => {
        call += 1;
        // The first run fails the way the vulnerable version should; every later one passes.
        return {
          exitCode: call === 1 ? 1 : 0,
          signal: null,
          timedOut: false,
          outputLimitExceeded: false,
          durationMs: 1,
          stdout: "",
          stderr: call === 1 ? "AssertionError [ERR_ASSERTION]: boom\n" : "",
        };
      },
    });
    const result = await flaky.prove(GOOD);
    expect(call).toBe(3);
    expect(result).toMatchObject({ accepted: false, stage: "confirmed" });
    expect(result.reason).toContain("repeatable");
  });

  describe("scripts that misbehave", () => {
    it("refuses, before running, a script that reaches for the network, the environment, processes or the version", async () => {
      for (const body of [
        `fetch("http://example.com")`,
        `const e = process.env.HOME; console.log(e)`,
        `require("node:child_process").execSync("id")`,
        `require("node:net").connect(80, "example.com")`,
        `console.log(require("fakepkg/package.json").version)`,
        `if (require("fakepkg").version === "1.0.0") process.exit(1)`,
        `process.kill(process.ppid, "SIGKILL")`,
        `eval("1")`,
        `const m = "child_" + "process"; require(m)`,
      ]) {
        const result = await harness.prove(
          `const assert = require("node:assert");\nrequire("fakepkg");\n${body}\n`,
        );
        expect({ body, accepted: result.accepted, stage: result.stage }).toEqual({
          body,
          accepted: false,
          stage: "screen",
        });
        expect(result.vulnerableRun).toBeUndefined();
      }
    });

    it("kills a script that loops forever and rejects it", async () => {
      const result = await harness.prove(`require("fakepkg"); while (true) {}`);
      expect(result).toMatchObject({ accepted: false, stage: "vulnerable" });
      expect(result.vulnerableRun).toMatchObject({ verdict: "timeout", timedOut: true });
    });

    it("kills a script that floods its output and rejects it", async () => {
      const result = await harness.prove(`
        require("fakepkg");
        const chunk = "y".repeat(4096);
        const flood = () => { process.stdout.write(chunk); setImmediate(flood); };
        flood();
      `);
      expect(result.accepted).toBe(false);
      expect(result.vulnerableRun).toMatchObject({
        verdict: "output-limit",
        outputLimitExceeded: true,
      });
      expect(result.vulnerableRun?.outputTail.length).toBeLessThanOrEqual(2000);
    });

    it("contains a script that gets past the screen and rejects it for trying: file access outside, caught by the sandbox", async () => {
      const result = await harness.prove(`
        const assert = require("node:assert");
        require("fakepkg");
        let leaked = false;
        try { require("node:fs").readFileSync("/etc/hosts"); leaked = true; } catch (error) { console.error(String(error.code)); }
        assert.ok(!leaked, "leaked");
        process.exit(1);
      `);
      expect(result.accepted).toBe(false);
      expect(result.vulnerableRun?.verdict).toBe("sandbox-violation");
    });
  });
});
