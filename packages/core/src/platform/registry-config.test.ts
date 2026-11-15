import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_NPM_REGISTRY,
  createRegistryConfig,
  loadRegistryConfig,
  packumentUrl,
  parseNpmrc,
} from "./registry-config.js";

/** npm's `${VAR}` reference, built so the source holds no literal placeholder. */
const envRef = (name: string): string => ["$", "{", name, "}"].join("");

describe("parseNpmrc", () => {
  it("parses keys, quotes and comments", () => {
    const values = parseNpmrc(
      [
        "; comment",
        "# another",
        "registry=https://npm.example.com/",
        '@acme:registry="https://acme.example.com/npm/"',
        "",
        "no-equals-line",
      ].join("\n"),
      {},
    );
    expect(values.get("registry")).toBe("https://npm.example.com/");
    expect(values.get("@acme:registry")).toBe("https://acme.example.com/npm/");
    expect(values.size).toBe(2);
  });

  it("expands environment variables and drops entries with unset variables", () => {
    const values = parseNpmrc(
      `//npm.example.com/:_authToken=${envRef("NPM_TOKEN")}\n//other.example.com/:_authToken=${envRef("MISSING")}`,
      { NPM_TOKEN: "secret" },
    );
    expect(values.get("//npm.example.com/:_authToken")).toBe("secret");
    expect(values.has("//other.example.com/:_authToken")).toBe(false);
  });
});

describe("createRegistryConfig", () => {
  it("defaults to the public registry with no credentials", () => {
    const config = createRegistryConfig(new Map(), {});
    expect(config.registryUrlFor("lodash")).toBe(DEFAULT_NPM_REGISTRY);
    expect(config.headersFor(`${DEFAULT_NPM_REGISTRY}/lodash`)).toEqual({});
  });

  it("uses the configured default registry without a trailing slash", () => {
    const config = createRegistryConfig(
      parseNpmrc("registry=https://npm.example.com/base/", {}),
      {},
    );
    expect(config.registryUrlFor("lodash")).toBe("https://npm.example.com/base");
  });

  it("routes scoped packages to their scope registry only", () => {
    const config = createRegistryConfig(
      parseNpmrc("@acme:registry=https://acme.example.com/npm/", {}),
      {},
    );
    expect(config.registryUrlFor("@acme/core")).toBe("https://acme.example.com/npm");
    expect(config.registryUrlFor("@other/core")).toBe(DEFAULT_NPM_REGISTRY);
    expect(config.registryUrlFor("lodash")).toBe(DEFAULT_NPM_REGISTRY);
  });

  it("lets npm_config_registry override the file", () => {
    const config = createRegistryConfig(parseNpmrc("registry=https://file.example.com/", {}), {
      npm_config_registry: "https://env.example.com",
    });
    expect(config.registryUrlFor("lodash")).toBe("https://env.example.com");
  });

  it("attaches bearer and basic credentials to matching URLs only", () => {
    const config = createRegistryConfig(
      parseNpmrc(
        [
          "//npm.example.com/:_authToken=tok",
          "//basic.example.com/:_auth=dXNlcjpwYXNz",
        ].join("\n"),
        {},
      ),
      {},
    );
    expect(config.headersFor("https://npm.example.com/lodash")).toEqual({
      Authorization: "Bearer tok",
    });
    expect(config.headersFor("https://basic.example.com/x/-/x-1.0.0.tgz")).toEqual({
      Authorization: "Basic dXNlcjpwYXNz",
    });
    // A tarball hosted elsewhere never receives the registry's credentials.
    expect(config.headersFor("https://cdn.example.net/lodash.tgz")).toEqual({});
    expect(config.headersFor("https://npm.example.com.evil.test/lodash")).toEqual({});
  });

  it("prefers the longest matching credential prefix", () => {
    const config = createRegistryConfig(
      parseNpmrc(["//host.example.com/:_authToken=root", "//host.example.com/team/:_authToken=team"].join("\n"), {}),
      {},
    );
    expect(config.headersFor("https://host.example.com/team/pkg").Authorization).toBe("Bearer team");
    expect(config.headersFor("https://host.example.com/pkg").Authorization).toBe("Bearer root");
  });

  it("does not send credentials over plain http except to localhost", () => {
    const config = createRegistryConfig(
      parseNpmrc(["//npm.example.com/:_authToken=tok", "//localhost:4873/:_authToken=local"].join("\n"), {}),
      {},
    );
    expect(config.headersFor("http://npm.example.com/lodash")).toEqual({});
    expect(config.headersFor("http://localhost:4873/lodash")).toEqual({
      Authorization: "Bearer local",
    });
  });
});

describe("packumentUrl", () => {
  it("encodes only the slash of scoped names", () => {
    const config = createRegistryConfig(new Map(), {});
    expect(packumentUrl(config, "lodash")).toBe("https://registry.npmjs.org/lodash");
    expect(packumentUrl(config, "@scope/name")).toBe("https://registry.npmjs.org/@scope%2Fname");
  });
});

describe("loadRegistryConfig", () => {
  it("lets the project .npmrc override the user .npmrc", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-config-"));
    try {
      const userFile = join(dir, "user.npmrc");
      writeFileSync(userFile, "registry=https://user.example.com/\n@acme:registry=https://user-acme.example.com/\n");
      const project = join(dir, "project");
      mkdirSync(project);
      writeFileSync(join(project, ".npmrc"), "registry=https://project.example.com/\n");

      const config = loadRegistryConfig(project, { NPM_CONFIG_USERCONFIG: userFile });
      expect(config.registryUrlFor("lodash")).toBe("https://project.example.com");
      expect(config.registryUrlFor("@acme/x")).toBe("https://user-acme.example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the public registry when no files exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-config-empty-"));
    try {
      const config = loadRegistryConfig(dir, { NPM_CONFIG_USERCONFIG: join(dir, "missing") });
      expect(config.registryUrlFor("lodash")).toBe(DEFAULT_NPM_REGISTRY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a project .npmrc cannot send an ambient secret to a registry of its own choosing", () => {
  const env = (project: string, userFile: string) => ({
    NPM_CONFIG_USERCONFIG: userFile,
    GITHUB_TOKEN: "ghs_ambient",
    NPM_TOKEN: "npm_for_npm",
    cwd: project,
  });

  function load(npmrc: string, extraEnv: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "registry-config-trust-"));
    try {
      const project = join(dir, "project");
      mkdirSync(project);
      writeFileSync(join(project, ".npmrc"), npmrc);
      const merged = { ...env(project, join(dir, "none")), ...extraEnv };
      return loadRegistryConfig(project, merged);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("drops a credential that expands GITHUB_TOKEN for an unknown host", () => {
    const config = load(
      `registry=https://evil.example/\n//evil.example/:_authToken=${envRef("GITHUB_TOKEN")}\n`,
    );
    expect(config.headersFor("https://evil.example/pkg")).toEqual({});
  });

  it("keeps a credential from an npm-specific variable", () => {
    const config = load(
      `registry=https://private.example/\n//private.example/:_authToken=${envRef("NPM_TOKEN")}\n`,
    );
    expect(config.headersFor("https://private.example/pkg")).toEqual({ Authorization: "Bearer npm_for_npm" });
  });

  it("keeps any variable for the well-known registry hosts, such as GitHub Packages", () => {
    const config = load(`//npm.pkg.github.com/:_authToken=${envRef("GITHUB_TOKEN")}\n`);
    expect(config.headersFor("https://npm.pkg.github.com/x")).toEqual({ Authorization: "Bearer ghs_ambient" });
  });

  it("keeps a literal credential and non-credential keys that expand variables", () => {
    const config = load(`registry=${envRef("NPM_CONFIG_REGISTRY_BASE")}/\n//x.example/:_authToken=literal\n`, {
      NPM_CONFIG_REGISTRY_BASE: "https://mirror.example",
    });
    expect(config.registryUrlFor("lodash")).toBe("https://mirror.example");
    expect(config.headersFor("https://x.example/p")).toEqual({ Authorization: "Bearer literal" });
  });

  it("does not apply the rule to the user's own .npmrc", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-config-user-"));
    try {
      const userFile = join(dir, "user.npmrc");
      writeFileSync(userFile, `//corp.example/:_authToken=${envRef("GITHUB_TOKEN")}\n`);
      const config = loadRegistryConfig(dir, { NPM_CONFIG_USERCONFIG: userFile, GITHUB_TOKEN: "ghs_user" });
      expect(config.headersFor("https://corp.example/p")).toEqual({ Authorization: "Bearer ghs_user" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

