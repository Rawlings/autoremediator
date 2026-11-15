import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { packageTarball } from "../../remediation/impact/__tests__/fixtures.js";
import { createByteBudget, createDefaultRadarDeps, ByteBudgetExceeded } from "./deps.js";
import { radar } from "./index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "radar-deps-"));
  vi.stubEnv("NPM_CONFIG_USERCONFIG", join(dir, "no-user-npmrc"));
  vi.stubEnv("npm_config_registry", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const write = (path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

describe("listInstalled", () => {
  it("reads direct and transitive packages from the lockfile, and skips what nothing asks for", () => {
    write(
      "package.json",
      JSON.stringify({
        name: "app",
        dependencies: { a: "^1.0.0" },
        devDependencies: { d: "^1.0.0" },
      }),
    );
    write(
      "package-lock.json",
      JSON.stringify({
        name: "app",
        lockfileVersion: 3,
        packages: {
          "": { name: "app", dependencies: { a: "^1.0.0" }, devDependencies: { d: "^1.0.0" } },
          "node_modules/a": { version: "1.0.0", dependencies: { b: "^1.0.0" } },
          "node_modules/b": { version: "1.2.0" },
          "node_modules/d": { version: "3.0.0", dev: true },
          "node_modules/orphan": { version: "9.9.9" },
        },
      }),
    );
    const installed = createDefaultRadarDeps().listInstalled(dir);
    expect(installed.toSorted((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: "a", version: "1.0.0", direct: true, scope: "production" },
      { name: "b", version: "1.2.0", direct: false, scope: "production" },
      { name: "d", version: "3.0.0", direct: true, scope: "development" },
    ]);
  });

  it("falls back to node_modules for direct dependencies when there is no lockfile", () => {
    write(
      "package.json",
      JSON.stringify({ name: "app", dependencies: { a: "^1.0.0", missing: "^1.0.0" } }),
    );
    write("node_modules/a/package.json", JSON.stringify({ name: "a", version: "1.4.0" }));
    expect(createDefaultRadarDeps().listInstalled(dir)).toEqual([
      { name: "a", version: "1.4.0", direct: true, scope: "production" },
    ]);
  });
});

/** Serve a registry, OSV and GitHub from memory. */
function stubNetwork(options: { githubStatus?: number; githubRemaining?: string } = {}) {
  const tarball = packageTarball(
    { "index.js": "if (k === '__proto__') return;\n" },
    { name: "pkg", version: "1.0.1", repository: { url: "git+https://github.com/acme/pkg.git" } },
  );
  const tarballWithDocs = (() => {
    // Rebuild with a changelog next to the source.
    return packageTarball(
      {
        "index.js": "if (k === '__proto__') return;\n",
        "CHANGELOG.md": "## 1.0.1\n- Fixed ReDoS.\n",
      },
      { name: "pkg", version: "1.0.1" },
    );
  })();
  const integrity = (bytes: Uint8Array) =>
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push(url);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    if (url === "https://registry.npmjs.org/pkg") {
      return json({
        "dist-tags": { latest: "1.0.1" },
        versions: { "1.0.0": {}, "1.0.1": {}, "1.1.0-beta.1": {} },
        time: { "1.0.0": "2024-01-01T00:00:00Z", "1.0.1": "2024-01-02T00:00:00Z" },
      });
    }
    if (url === "https://registry.npmjs.org/pkg/1.0.1") {
      return json({
        dist: {
          tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.1.tgz",
          integrity: integrity(tarballWithDocs),
        },
      });
    }
    if (url === "https://registry.npmjs.org/pkg/1.0.2") {
      return json({
        dist: {
          tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.2.tgz",
          integrity: "sha512-AAAA",
        },
      });
    }
    if (url.endsWith("pkg-1.0.1.tgz") || url.endsWith("pkg-1.0.2.tgz"))
      return new Response(tarballWithDocs);
    if (url === "https://registry.npmjs.org/gone") return json({}, 404);
    if (url === "https://api.osv.dev/v1/query") {
      expect(init?.method).toBe("POST");
      return json({
        vulns: [
          {
            id: "GHSA-test-test-test",
            affected: [
              {
                package: { name: "pkg", ecosystem: "npm" },
                ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }],
              },
            ],
          },
        ],
      });
    }
    if (url.startsWith("https://api.github.com/repos/acme/pkg/releases")) {
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["User-Agent"]).toBe("autoremediator-radar");
      return json(
        [
          { tag_name: "v1.0.1", body: "Fixed XSS" },
          { tag_name: "x", body: null },
        ],
        options.githubStatus ?? 200,
        {
          "x-ratelimit-remaining": options.githubRemaining ?? "50",
          "x-ratelimit-reset": "1893456000",
        },
      );
    }
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, tarball };
}

describe("default registry dependencies", () => {
  it("reads versions, times and deprecations from the packument, stable versions only", async () => {
    stubNetwork();
    const budget = createByteBudget(10_000_000);
    const versions = await createDefaultRadarDeps().fetchVersions("pkg", dir, budget);
    expect(versions?.latest).toBe("1.0.1");
    expect(versions?.versions).toEqual([
      { version: "1.0.0", publishedAt: "2024-01-01T00:00:00Z" },
      { version: "1.0.1", publishedAt: "2024-01-02T00:00:00Z" },
    ]);
    expect(budget.used).toBeGreaterThan(0);
    await expect(
      createDefaultRadarDeps().fetchVersions("gone", dir, budget),
    ).resolves.toBeUndefined();
  });

  it("downloads a tarball, verifies its integrity, keeps the changelog and charges the budget", async () => {
    stubNetwork();
    const budget = createByteBudget(10_000_000);
    const loaded = await createDefaultRadarDeps().loadPackage("pkg", "1.0.1", dir, budget);
    expect(loaded.integrityVerified).toBe(true);
    expect([...loaded.files.keys()]).toEqual(["index.js"]);
    expect(loaded.docs.get("CHANGELOG.md")).toContain("Fixed ReDoS");
    expect(budget.used).toBeGreaterThan(100);
  });

  it("refuses a tarball that fails its integrity check, and invalid names and versions", async () => {
    stubNetwork();
    const deps = createDefaultRadarDeps();
    await expect(deps.loadPackage("pkg", "1.0.2", dir, createByteBudget(1e7))).rejects.toThrow(
      /failed verification/,
    );
    await expect(deps.loadPackage("../evil", "1.0.0", dir, createByteBudget(1e7))).rejects.toThrow(
      /Invalid package name/,
    );
    await expect(deps.loadPackage("pkg", "^1.0.0", dir, createByteBudget(1e7))).rejects.toThrow(
      /exact version/,
    );
    await expect(deps.fetchVersions("a b", dir, createByteBudget(1e7))).rejects.toThrow(
      /Invalid package name/,
    );
  });

  it("refuses to download once the budget is spent", async () => {
    stubNetwork();
    const budget = createByteBudget(10);
    budget.charge(10);
    await expect(
      createDefaultRadarDeps().loadPackage("pkg", "1.0.1", dir, budget),
    ).rejects.toBeInstanceOf(ByteBudgetExceeded);
  });

  it("asks OSV about the installed version", async () => {
    stubNetwork();
    await expect(createDefaultRadarDeps().queryAdvisories("pkg", "1.0.0")).resolves.toEqual([
      { id: "GHSA-test-test-test", fixedIn: "1.0.1", range: ">=0.0.0 <1.0.1" },
    ]);
  });
});

describe("GitHub release notes", () => {
  it("is unauthenticated and keeps only releases with a tag and a body", async () => {
    vi.stubEnv("GITHUB_TOKEN", "must-not-be-sent");
    stubNetwork();
    const result = await createDefaultRadarDeps().fetchGithubReleases({
      owner: "acme",
      repo: "pkg",
    });
    expect(result.releases).toEqual([{ tag: "v1.0.1", body: "Fixed XSS" }]);
  });

  it("stops asking after the rate limit and says so", async () => {
    const { calls } = stubNetwork({ githubStatus: 403, githubRemaining: "0" });
    const deps = createDefaultRadarDeps();
    const first = await deps.fetchGithubReleases({ owner: "acme", repo: "pkg" });
    expect(first.releases).toEqual([]);
    expect(first.note).toMatch(/rate limit reached \(resets 2030-/);
    const second = await deps.fetchGithubReleases({ owner: "acme", repo: "pkg" });
    expect(second.note).toBe(first.note);
    expect(calls.filter((url) => url.includes("api.github.com"))).toHaveLength(1);
  });

  it("warns when the remaining quota is nearly spent", async () => {
    stubNetwork({ githubRemaining: "1" });
    const deps = createDefaultRadarDeps();
    expect((await deps.fetchGithubReleases({ owner: "acme", repo: "pkg" })).note).toMatch(
      /nearly spent/,
    );
    expect((await deps.fetchGithubReleases({ owner: "acme", repo: "pkg" })).releases).toEqual([]);
  });
});

describe("radar over a stubbed network, end to end", () => {
  it("reads the lockfile, downloads two tarballs, flags the release and cross-checks OSV", async () => {
    write("package.json", JSON.stringify({ name: "app", dependencies: { pkg: "^1.0.0" } }));
    write(
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { pkg: "^1.0.0" } },
          "node_modules/pkg": { version: "1.0.0" },
        },
      }),
    );
    // 1.0.0 must exist too: serve the same tarball for it.
    const { calls } = stubNetwork();
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (url === "https://registry.npmjs.org/pkg/1.0.0") {
        const bytes = packageTarball(
          { "index.js": "exports.a = 1;\n" },
          { name: "pkg", version: "1.0.0" },
        );
        return new Response(
          JSON.stringify({
            dist: {
              tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
              integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
            },
          }),
        );
      }
      if (url.endsWith("pkg-1.0.0.tgz")) {
        return new Response(
          packageTarball({ "index.js": "exports.a = 1;\n" }, { name: "pkg", version: "1.0.0" }),
        );
      }
      return original(input, init);
    });
    const report = await radar({ cwd: dir, assess: false });
    expect(report.entries).toHaveLength(1);
    const [entry] = report.entries;
    expect(entry).toMatchObject({
      name: "pkg",
      installed: "1.0.0",
      target: "1.0.1",
      status: "now-advisory",
    });
    expect(entry?.advisories).toEqual([{ id: "GHSA-test-test-test", fixedIn: "1.0.1" }]);
    expect(entry?.flags.map((flag) => flag.signal)).toEqual(
      expect.arrayContaining(["prototype-guard-added", "changelog:redos"]),
    );
    expect(report.bytesDownloaded).toBeGreaterThan(0);
    expect(calls.some((url) => url.includes("api.github.com"))).toBe(false);
  });
});
