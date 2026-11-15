import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "./program.js";

let dir: string;
let out: string;
let stdout: string;
let keyPath: string;
let publicPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "evidence-cli-"));
  out = join(dir, "pack");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "cli-app", version: "0.1.0", dependencies: { left: "1.0.0" } }),
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "cli-app", version: "0.1.0", dependencies: { left: "1.0.0" } },
        "node_modules/left": { version: "1.0.0", license: "MIT" },
      },
    }),
  );
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  keyPath = join(dir, "key.pem");
  publicPath = join(dir, "key.pub.pem");
  writeFileSync(keyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(publicPath, pair.publicKey.export({ type: "spki", format: "pem" }));
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

describe("autoremediator evidence-pack", () => {
  it("needs --out", async () => {
    await expect(run("evidence-pack", "--cwd", dir)).rejects.toThrow(/--out <dir> is required/);
  });

  it("writes an unsigned pack and says so, then verifies it", async () => {
    await run("evidence-pack", "--cwd", dir, "--out", out);
    expect(stdout).toContain("attestations UNSIGNED (signed: false)");
    expect(stdout).toContain("1 components from package-lock.json");
    expect(stdout).toContain("not legal advice or a compliance claim");

    stdout = "";
    await run("evidence-pack", "verify", out);
    expect(stdout).toContain("OK: every file matches the manifest.");
    expect(stdout).toContain("attestations are unsigned");
    expect(process.exitCode).toBe(0);
  });

  it("signs with --signing-key and verifies against the public key, failing on a wrong one", async () => {
    await run(
      "evidence-pack",
      "--cwd",
      dir,
      "--out",
      out,
      "--signing-key",
      keyPath,
      "--output-format",
      "json",
    );
    const result = JSON.parse(stdout) as { signed: boolean; signingAlgorithm: string };
    expect(result).toMatchObject({ signed: true, signingAlgorithm: "ecdsa-p256-sha256" });

    stdout = "";
    await run("evidence-pack", "verify", out, "--public-key", publicPath);
    expect(stdout).toContain("signatures verified against the key you gave");
    expect(process.exitCode).toBe(0);

    const stranger = join(dir, "other.pub.pem");
    writeFileSync(
      stranger,
      generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
        type: "spki",
        format: "pem",
      }),
    );
    stdout = "";
    await run("evidence-pack", "verify", out, "--public-key", stranger);
    expect(stdout).toContain("FAILED:");
    expect(process.exitCode).toBe(1);
  });

  it("refuses an awareness time without a zone and a malformed --awareness pair", async () => {
    await expect(
      run("evidence-pack", "--cwd", dir, "--out", out, "--awareness-at", "2026-11-10T10:00:00"),
    ).rejects.toThrow(/time zone/);
    await expect(
      run("evidence-pack", "--cwd", dir, "--out", out, "--awareness", "CVE-1"),
    ).rejects.toThrow(/--awareness expects/);
  });
});
