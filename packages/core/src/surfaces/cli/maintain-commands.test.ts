import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFake, vexDocument } from "../../features/maintainer-vex/testing/fixtures.js";
import { createProgram } from "./program.js";

let dir: string;
let stdout: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maintain-cli-"));
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const run = (...args: string[]) => createProgram().parseAsync(["node", "autoremediator", ...args]);

describe("autoremediator vex show", () => {
  it("lists shipped documents and rejections as text and JSON", async () => {
    installFake(dir, { name: "bad-dep", version: "1.0.0" });
    installFake(dir, {
      name: "lib",
      version: "2.0.0",
      dependencies: { "bad-dep": "^1" },
      vex: true,
      files: {
        "vex.openvex.json": vexDocument({ name: "lib", version: "2.0.0" }, [
          { vulnerability: "CVE-2026-1111", subcomponents: ["pkg:npm/bad-dep"] },
        ]),
      },
    });
    installFake(dir, {
      name: "broken",
      version: "1.0.0",
      vex: true,
      files: { "vex.openvex.json": "{" },
    });

    await run("vex", "show", "--cwd", dir);
    expect(stdout).toContain("lib@2.0.0");
    expect(stdout).toContain(
      "CVE-2026-1111 about bad-dep: not_affected (vulnerable_code_not_in_execute_path)",
    );
    expect(stdout).toContain("rejected broken@1.0.0");

    stdout = "";
    await run(
      "vex",
      "show",
      "--cwd",
      dir,
      "--advisory",
      "CVE-2026-9999",
      "--output-format",
      "json",
    );
    const report = JSON.parse(stdout) as {
      packages: unknown[];
      rejected: unknown[];
      scanned: number;
    };
    expect(report.packages).toEqual([]);
    expect(report.rejected).toHaveLength(1);
    expect(report.scanned).toBe(3);
  });
});

describe("autoremediator maintain", () => {
  function project(): void {
    for (const [path, content] of Object.entries({
      "package.json": JSON.stringify(
        {
          name: "demo-lib",
          version: "1.0.0",
          files: ["src"],
          dependencies: { "bad-dep": "^1.0.0" },
        },
        null,
        2,
      ),
      "src/index.js": "module.exports = 1;\n",
      ".changeset/config.json": "{}",
      "snap.json": JSON.stringify({
        "CVE-2026-1111": { packageName: "bad-dep", vulnerableRange: "<2.0.0", severity: "HIGH" },
      }),
    })) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    installFake(dir, { name: "bad-dep", version: "1.0.0" });
  }
  const args = (...more: string[]) => [
    "maintain",
    "--cwd",
    dir,
    "--advisories",
    "CVE-2026-1111",
    "--offline",
    "--intelligence-snapshot",
    join(dir, "snap.json"),
    ...more,
  ];

  it("shows a diff and exits 3 without --yes, then writes everything with --yes and is idempotent", async () => {
    project();
    await run(...args("--assert-not-affected"));
    expect(stdout).toContain("CVE-2026-1111 [HIGH]: not_affected");
    expect(stdout).toContain("+++ b/vex.openvex.json");
    expect(stdout).toContain("Nothing written. Run again with --yes to apply.");
    expect(process.exitCode).toBe(3);
    expect(existsSync(join(dir, "vex.openvex.json"))).toBe(false);
    expect(existsSync(join(dir, ".autoremediator"))).toBe(false);

    stdout = "";
    process.exitCode = undefined;
    await run(...args("--assert-not-affected", "--yes"));
    expect(stdout).toContain("Nothing was published or pushed");
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      vex: string;
      files: string[];
    };
    expect(manifest.vex).toBe("vex.openvex.json");
    expect(manifest.files).toEqual(["src", "vex.openvex.json"]);
    expect(
      readdirSync(join(dir, ".changeset")).filter((name) => name.startsWith("maintain-")),
    ).toHaveLength(1);

    stdout = "";
    await run(...args("--assert-not-affected", "--yes"));
    expect(stdout).toContain("Nothing to change.");
  }, 60_000);

  it("prints JSON", async () => {
    project();
    await run(...args("--output-format", "json"));
    const result = JSON.parse(stdout) as {
      advisories: Array<{ decision: string }>;
      drift: boolean;
      applied: boolean;
    };
    expect(result.advisories[0]?.decision).toBe("under_investigation");
    expect(result.drift).toBe(true);
    expect(result.applied).toBe(false);
  }, 60_000);

  it("refuses an offline run that names no advisories, and a bad id", async () => {
    project();
    await expect(run("maintain", "--cwd", dir, "--offline")).rejects.toThrow(
      /Audit needs the network/,
    );
    await expect(run("maintain", "--cwd", dir, "--advisories", "nope")).rejects.toThrow(
      /Not a CVE or GHSA id/,
    );
  });
});
