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
});
