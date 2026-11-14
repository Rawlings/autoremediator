import type { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";

import { fetchRepoConfig } from "./repo-config.js";

async function configFrom(yaml: string) {
  const octokit = {
    rest: {
      repos: {
        getContent: async () => ({
          data: { type: "file", content: Buffer.from(yaml, "utf8").toString("base64") },
        }),
      },
    },
  } as unknown as Octokit;
  return fetchRepoConfig(octokit, "acme", "web");
}

describe("botPrDoctor and PR healing settings", () => {
  it("is off with two attempts when the key is absent", async () => {
    const config = await configFrom("dryRun: false");
    expect(config.botPrDoctor).toEqual({ enabled: false, maxAttempts: 2 });
  });

  it("reads enabled and maxAttempts", async () => {
    const config = await configFrom("botPrDoctor:\n  enabled: true\n  maxAttempts: 4");
    expect(config.botPrDoctor).toEqual({ enabled: true, maxAttempts: 4 });
  });

  it("an object without enabled stays off", async () => {
    const config = await configFrom("botPrDoctor:\n  maxAttempts: 3");
    expect(config.botPrDoctor).toEqual({ enabled: false, maxAttempts: 3 });
  });

  it("accepts a boolean as shorthand for on or off with the default cap", async () => {
    expect((await configFrom("botPrDoctor: true")).botPrDoctor).toEqual({
      enabled: true,
      maxAttempts: 2,
    });
    expect((await configFrom("botPrDoctor: false")).botPrDoctor).toEqual({
      enabled: false,
      maxAttempts: 2,
    });
  });

  it.each(["0", "-1", "9", "2.5", '"3"', "null", "[2]"])(
    "falls back to the default cap for maxAttempts %s",
    async (value) => {
      const config = await configFrom(`botPrDoctor:\n  enabled: true\n  maxAttempts: ${value}`);
      expect(config.botPrDoctor).toEqual({ enabled: true, maxAttempts: 2 });
    },
  );

  it.each(["yes please", "42", "[true]", "null", '"true"'])(
    "never switches on from %s",
    async (value) => {
      const config = await configFrom(`botPrDoctor: ${value}`);
      expect(config.botPrDoctor?.enabled).toBe(false);
    },
  );

  it("reads the documented PR healing keys instead of dropping them", async () => {
    const config = await configFrom("enablePrAutoHealing: true\nmaxHealingAttempts: 5");
    expect(config.enablePrAutoHealing).toBe(true);
    expect(config.maxHealingAttempts).toBe(5);
  });

  it("ignores invalid PR healing values", async () => {
    const config = await configFrom('enablePrAutoHealing: "yes"\nmaxHealingAttempts: 500');
    expect(config.enablePrAutoHealing).toBe(false);
    expect(config.maxHealingAttempts).toBe(3);
  });
});
