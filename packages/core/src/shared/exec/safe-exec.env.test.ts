import { afterEach, describe, expect, it } from "vitest";

import { safeExeca } from "./safe-exec.js";

describe("safeExeca environment isolation (real child process)", () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
  });

  const probe = (name: string) =>
    safeExeca(process.execPath, [
      "-e",
      `process.stdout.write(process.env[${JSON.stringify(name)}] ?? "<unset>")`,
    ]);

  it("does not leak NODE_OPTIONS or other injection vectors from the parent environment", async () => {
    process.env.NODE_OPTIONS = "--max-old-space-size=64";
    process.env.LD_PRELOAD = "/tmp/evil.so";
    expect((await probe("NODE_OPTIONS")).stdout).toBe("<unset>");
    expect((await probe("LD_PRELOAD")).stdout).toBe("<unset>");
  });

  it("still passes ordinary variables through", async () => {
    process.env.AR_TEST_PLAIN = "ok";
    expect((await probe("AR_TEST_PLAIN")).stdout).toBe("ok");
  });

  it("honours an explicit env without merging the parent's back in", async () => {
    process.env.AR_TEST_PARENT_ONLY = "parent";
    const result = await safeExeca(
      process.execPath,
      ["-e", "process.stdout.write(String(process.env.AR_TEST_PARENT_ONLY))"],
      { env: { PATH: process.env.PATH } },
    );
    expect(result.stdout).toBe("undefined");
  });

  it("removes credentials from the child's environment", async () => {
    process.env.AUTOREMEDIATOR_JWT_SECRET = "jwt";
    process.env.AUTOREMEDIATOR_API_TOKENS = "admin:abc";
    process.env.AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY = "pem";
    process.env.GITHUB_TOKEN = "ghs_x";
    process.env.GH_TOKEN = "ghs_y";
    process.env.ANTHROPIC_API_KEY = "sk-ant-x";
    process.env.OPENAI_API_KEY = "sk-x";
    process.env.AWS_SECRET_ACCESS_KEY = "aws";
    process.env.MY_SERVICE_PASSWORD = "pw";
    for (const name of [
      "AUTOREMEDIATOR_JWT_SECRET",
      "AUTOREMEDIATOR_API_TOKENS",
      "AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "MY_SERVICE_PASSWORD",
    ]) {
      expect([name, (await probe(name)).stdout]).toEqual([name, "<unset>"]);
    }
  });

  it("keeps registry auth variables and non-secret switches", async () => {
    process.env.NPM_TOKEN = "npm";
    process.env.NODE_AUTH_TOKEN = "node";
    process.env.AUTOREMEDIATOR_ALLOWED_ROOTS = "/tmp";
    process.env.AUTOREMEDIATOR_TRACE_FILE = "/tmp/trace.jsonl";
    expect((await probe("NPM_TOKEN")).stdout).toBe("npm");
    expect((await probe("NODE_AUTH_TOKEN")).stdout).toBe("node");
    expect((await probe("AUTOREMEDIATOR_ALLOWED_ROOTS")).stdout).toBe("/tmp");
    expect((await probe("AUTOREMEDIATOR_TRACE_FILE")).stdout).toBe("/tmp/trace.jsonl");
  });

  it("passes a named secret through only when the caller opts in", async () => {
    process.env.DATABASE_PASSWORD = "db";
    const result = await safeExeca(
      process.execPath,
      ["-e", "process.stdout.write(process.env.DATABASE_PASSWORD ?? '<unset>')"],
      { passEnv: ["DATABASE_PASSWORD"] },
    );
    expect(result.stdout).toBe("db");
  });
});
