import { describe, expect, it } from "vitest";
import { safeExeca, sanitizeEnvironment, validateCommandArguments } from "./safe-exec.js";

describe("safe-exec", () => {
  describe("sanitizeEnvironment", () => {
    it("strips dangerous process-injection environment variables", () => {
      const hostileEnv = {
        NODE_OPTIONS: "--require /malicious.js",
        LD_PRELOAD: "/lib/evil.so",
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
        PATH: "/usr/bin:/bin",
        CUSTOM_VAR: "safe",
      };

      const sanitized = sanitizeEnvironment(hostileEnv);
      expect(sanitized.NODE_OPTIONS).toBeUndefined();
      expect(sanitized.LD_PRELOAD).toBeUndefined();
      expect(sanitized.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(sanitized.PATH).toBe("/usr/bin:/bin");
      expect(sanitized.CUSTOM_VAR).toBe("safe");
    });

    it("allows NODE_OPTIONS when explicitly opted-in", () => {
      const env = { NODE_OPTIONS: "--max-old-space-size=4096" };
      const sanitized = sanitizeEnvironment(env, true);
      expect(sanitized.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    });
  });

  describe("validateCommandArguments", () => {
    it("throws error on null bytes in executable path", () => {
      expect(() => validateCommandArguments("node\0evil", ["test"])).toThrow(/contains null bytes/);
    });

    it("throws error on null bytes in arguments", () => {
      expect(() => validateCommandArguments("node", ["test\0evil"])).toThrow(
        /argument contains null bytes/,
      );
    });
  });

  describe("safeExeca", () => {
    it("executes safe commands successfully with environment sanitization", async () => {
      const result = await safeExeca("node", ["-e", "console.log('hello world');"]);
      expect(String(result.stdout).trim()).toBe("hello world");
    });
  });
});
