import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCooldown, withCooldown } from "./cooldown.js";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cooldown-"));
  // Keep the developer's real ~/.npmrc out of every test.
  env = { NPM_CONFIG_USERCONFIG: join(dir, "no-user-npmrc") };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (file: string, content: string) => writeFileSync(join(dir, file), content);

describe("readCooldown", () => {
  it("returns nothing when no cooldown is configured", () => {
    for (const pm of ["npm", "pnpm", "yarn", "bun", "deno"] as const) {
      expect(readCooldown(dir, pm, env)).toBeUndefined();
    }
  });

  it("reads npm min-release-age (days) from .npmrc and from the environment", () => {
    write(".npmrc", "min-release-age=3\n");
    expect(readCooldown(dir, "npm", env)).toMatchObject({
      hours: 72,
      source: "npm min-release-age",
    });
    expect(readCooldown(dir, "npm", { ...env, npm_config_min_release_age: "1" })?.hours).toBe(24);
  });

  it("reads pnpm minimumReleaseAge (minutes) and its exclusions from pnpm-workspace.yaml", () => {
    write(
      "pnpm-workspace.yaml",
      "minimumReleaseAge: 4320\nminimumReleaseAgeExclude:\n  - '@acme/*'\n  - webpack\n",
    );
    expect(readCooldown(dir, "pnpm", env)).toEqual({
      hours: 72,
      exclude: ["@acme/*", "webpack"],
      source: "pnpm minimumReleaseAge",
    });
  });

  it("reads pnpm minimum-release-age from .npmrc", () => {
    write(".npmrc", "minimum-release-age=120\n");
    expect(readCooldown(dir, "pnpm", env)?.hours).toBe(2);
  });

  it("applies pnpm 11's 24h default only when packageManager says pnpm 11 or newer", () => {
    write("package.json", JSON.stringify({ packageManager: "pnpm@10.18.0" }));
    expect(readCooldown(dir, "pnpm", env)).toBeUndefined();

    write("package.json", JSON.stringify({ packageManager: "pnpm@11.2.0" }));
    expect(readCooldown(dir, "pnpm", env)).toMatchObject({
      hours: 24,
      source: "pnpm 11 default minimumReleaseAge",
    });
  });

  it("lets an explicit pnpm 0 turn the default off", () => {
    write("package.json", JSON.stringify({ packageManager: "pnpm@11.2.0" }));
    write("pnpm-workspace.yaml", "minimumReleaseAge: 0\n");
    expect(readCooldown(dir, "pnpm", env)).toBeUndefined();
  });

  it("finds pnpm-workspace.yaml in a parent directory", () => {
    write("pnpm-workspace.yaml", "minimumReleaseAge: 60\n");
    const child = join(dir, "packages", "app");
    mkdirSync(child, { recursive: true });
    expect(readCooldown(child, "pnpm", env)?.hours).toBe(1);
  });

  it("reads yarn npmMinimalAgeGate (minutes) and ignores non-numeric values", () => {
    write(".yarnrc.yml", "npmMinimalAgeGate: 1440\n");
    expect(readCooldown(dir, "yarn", env)?.hours).toBe(24);

    write(".yarnrc.yml", "npmMinimalAgeGate: 3d\n");
    expect(readCooldown(dir, "yarn", env)).toBeUndefined();
  });

  it("reads bun minimumReleaseAge (seconds) and exclusions from bunfig.toml", () => {
    write(
      "bunfig.toml",
      "[install]\nminimumReleaseAge = 259200\nminimumReleaseAgeExcludes = [\"react\", '@types/*']\n",
    );
    expect(readCooldown(dir, "bun", env)).toEqual({
      hours: 72,
      exclude: ["react", "@types/*"],
      source: "bun minimumReleaseAge",
    });
  });

  it("survives malformed configuration files", () => {
    write("pnpm-workspace.yaml", ": : not yaml [");
    write(".yarnrc.yml", "{{{");
    expect(readCooldown(dir, "pnpm", env)).toBeUndefined();
    expect(readCooldown(dir, "yarn", env)).toBeUndefined();
  });
});

describe("withCooldown", () => {
  const cooldown = { hours: 72, exclude: ["@acme/*", "webpack"], source: "pnpm minimumReleaseAge" };

  it("leaves the policy alone without a cooldown", () => {
    const policy = { blockInstallScripts: true };
    expect(withCooldown(policy, undefined, "left-pad")).toBe(policy);
    expect(withCooldown(undefined, undefined, "left-pad")).toBeUndefined();
  });

  it("raises the minimum age to the cooldown and records its source", () => {
    expect(withCooldown({ blockInstallScripts: true }, cooldown, "left-pad")).toEqual({
      blockInstallScripts: true,
      minPublishAgeHours: 72,
      minPublishAgeSource: "pnpm minimumReleaseAge",
    });
    expect(withCooldown(undefined, cooldown, "left-pad")).toMatchObject({ minPublishAgeHours: 72 });
  });

  it("keeps a policy minimum that is already stricter", () => {
    const policy = { minPublishAgeHours: 168 };
    expect(withCooldown(policy, cooldown, "left-pad")).toBe(policy);
  });

  it("does not apply the cooldown to packages the package manager exempts", () => {
    expect(withCooldown(undefined, cooldown, "webpack")).toBeUndefined();
    expect(withCooldown(undefined, cooldown, "@acme/core")).toBeUndefined();
    expect(withCooldown(undefined, cooldown, "webpack-cli")).toMatchObject({
      minPublishAgeHours: 72,
    });
  });
});
