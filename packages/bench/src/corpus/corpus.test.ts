import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startRegistry } from "../registry.ts";
import { DEFAULT_TASKS_DIR } from "../task.ts";
import { assertAllowedUrl } from "./fetch.ts";
import { snapshotEntryOf } from "./freeze.ts";
import {
  assertAdmissible,
  fixedVersionsOf,
  osvSchema,
  severityOf,
  vulnerableRangeOf,
} from "./osv.ts";
import { parsePackument, trimPackument, versionsAsOf } from "./packument.ts";
import { isPackageName, isVersion, packumentPath, tarballCachePath } from "./paths.ts";
import { loadCorpus } from "./serve.ts";
import { verifyCorpus } from "./verify.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(extra: Record<string, unknown> = {}) {
  return osvSchema.parse({
    id: "GHSA-aaaa-bbbb-cccc",
    aliases: ["CVE-2024-0001"],
    summary: "A problem",
    modified: "2024-01-01T00:00:00Z",
    published: "2024-01-01T00:00:00Z",
    database_specific: { severity: "MODERATE" },
    affected: [
      {
        package: { ecosystem: "npm", name: "demo" },
        ranges: [
          {
            type: "SEMVER",
            events: [
              { introduced: "0" },
              { fixed: "1.0.2" },
              { introduced: "2.0.0" },
              { fixed: "2.2.2" },
            ],
          },
        ],
      },
    ],
    references: [{ url: "https://example.invalid/advisory" }],
    ...extra,
  });
}

describe("published advisories", () => {
  it("become a semver range, with every fixed version", () => {
    expect(vulnerableRangeOf(record(), "demo")).toBe(">=0.0.0 <1.0.2 || >=2.0.0 <2.2.2");
    expect(fixedVersionsOf(record(), "demo")).toEqual(["1.0.2", "2.2.2"]);
    expect(severityOf(record())).toBe("MEDIUM");
  });

  it("treat last_affected as inclusive and an open range as unbounded", () => {
    const open = record({
      affected: [
        {
          package: { ecosystem: "npm", name: "demo" },
          ranges: [
            {
              type: "SEMVER",
              events: [
                { introduced: "1.0.0" },
                { last_affected: "1.4.0" },
                { introduced: "3.0.0" },
              ],
            },
          ],
        },
      ],
    });
    expect(vulnerableRangeOf(open, "demo")).toBe(">=1.0.0 <=1.4.0 || >=3.0.0");
    expect(fixedVersionsOf(open, "demo")).toEqual([]);
  });

  it("are refused when they are malware, withdrawn, or about another package", () => {
    expect(() => assertAdmissible(record({ id: "MAL-2025-1" }), "demo")).toThrow(/malware/);
    expect(() => assertAdmissible(record({ aliases: ["MAL-2025-2"] }), "demo")).toThrow(/malware/);
    expect(() => assertAdmissible(record({ withdrawn: "2024-02-01T00:00:00Z" }), "demo")).toThrow(
      /withdrawn/,
    );
    expect(() => assertAdmissible(record(), "other")).toThrow(/does not affect/);
  });

  it("need a SEMVER range, not just a list of versions", () => {
    const listed = record({
      affected: [{ package: { ecosystem: "npm", name: "demo" }, ranges: [] }],
    });
    expect(() => vulnerableRangeOf(listed, "demo")).toThrow(/no SEMVER range/);
  });

  it("give a snapshot entry only under an id the record is known by", () => {
    const entry = snapshotEntryOf(record(), "CVE-2024-0001", "demo");
    expect(entry.affectedPackages[0]).toMatchObject({
      firstPatchedVersion: "1.0.2",
      source: "osv",
    });
    expect(() => snapshotEntryOf(record(), "CVE-2024-9999", "demo")).toThrow(/not known as/);
  });
});

describe("curation network access", () => {
  it("is limited to the npm registry and OSV over https", () => {
    expect(() => assertAllowedUrl("https://registry.npmjs.org/lodash")).not.toThrow();
    expect(() => assertAllowedUrl("https://api.osv.dev/v1/vulns/GHSA-x")).not.toThrow();
    expect(() => assertAllowedUrl("http://registry.npmjs.org/lodash")).toThrow(/Refusing/);
    expect(() => assertAllowedUrl("https://example.com/x.tgz")).toThrow(/Refusing/);
    expect(() => assertAllowedUrl("https://registry.npmjs.org.evil.invalid/x")).toThrow(/Refusing/);
  });
});

describe("packuments", () => {
  const packument = parsePackument({
    name: "demo",
    "dist-tags": { latest: "3.0.0", next: "2.0.0" },
    versions: {
      "1.0.0": {
        name: "demo",
        version: "1.0.0",
        readme: "x",
        maintainers: ["a"],
        dist: { tarball: "t", integrity: "i", shasum: "s" },
      },
      "2.0.0": {
        name: "demo",
        version: "2.0.0",
        dist: { tarball: "t", integrity: "i", shasum: "s" },
      },
      "3.0.0": {
        name: "demo",
        version: "3.0.0",
        dist: { tarball: "t", integrity: "i", shasum: "s" },
      },
    },
    time: {
      "1.0.0": "2020-01-01T00:00:00Z",
      "2.0.0": "2021-01-01T00:00:00Z",
      "3.0.0": "2025-01-01T00:00:00Z",
    },
  });

  it("keep only versions published by the snapshot date", () => {
    expect(versionsAsOf(packument, "2022-01-01T00:00:00Z")).toEqual(["1.0.0", "2.0.0"]);
  });

  it("drop descriptive fields, keep the registry's hashes, and repair dist-tags", () => {
    const trimmed = trimPackument(packument, ["1.0.0", "2.0.0"], "2022-01-01T00:00:00Z") as {
      versions: Record<string, Record<string, unknown>>;
      "dist-tags": Record<string, string>;
    };
    expect(trimmed.versions["1.0.0"]).not.toHaveProperty("readme");
    expect(trimmed.versions["1.0.0"]).not.toHaveProperty("maintainers");
    expect(trimmed.versions["1.0.0"]?.["dist"]).toMatchObject({ integrity: "i", shasum: "s" });
    expect(trimmed["dist-tags"]).toEqual({ next: "2.0.0", latest: "2.0.0" });
  });
});

describe("the registry serving a corpus", () => {
  function corpusDir() {
    const dir = mkdtempSync(join(tmpdir(), "bench-corpus-"));
    made.push(dir);
    const tarball = Buffer.from("not really a tarball, but bytes are bytes");
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    const shasum = createHash("sha1").update(tarball).digest("hex");
    mkdirSync(join(dir, "packuments"));
    mkdirSync(join(dir, "cache", "demo"), { recursive: true });
    writeFileSync(join(dir, "cache", "demo", "1.0.0.tgz"), tarball);
    writeFileSync(
      join(dir, "lock.json"),
      JSON.stringify({
        snapshotDate: "2026-01-01T00:00:00Z",
        packages: { demo: { versions: { "1.0.0": { integrity, shasum } }, excluded: {} } },
      }),
    );
    writeFileSync(
      join(dir, "packuments", "demo.json"),
      JSON.stringify({
        name: "demo",
        versions: {
          "1.0.0": {
            name: "demo",
            version: "1.0.0",
            dist: { tarball: "https://x/y.tgz", integrity, shasum },
          },
        },
      }),
    );
    return { dir, tarball };
  }

  const load = (dir: string) =>
    loadCorpus({
      lockPath: join(dir, "lock.json"),
      packumentDir: join(dir, "packuments"),
      cacheDir: join(dir, "cache"),
    });

  it("serves the published packument with local tarball URLs, and the tarball unchanged", async () => {
    const { dir, tarball } = corpusDir();
    const registry = await startRegistry({ corpus: load(dir) });
    try {
      const packument = (await (await fetch(`${registry.url}/demo`)).json()) as {
        versions: Record<string, { dist: { tarball: string; integrity: string } }>;
      };
      expect(packument.versions["1.0.0"]?.dist.tarball).toBe(
        `${registry.url}/demo/-/demo-1.0.0.tgz`,
      );
      const served = Buffer.from(
        await (await fetch(`${registry.url}/demo/-/demo-1.0.0.tgz`)).arrayBuffer(),
      );
      expect(served.equals(tarball)).toBe(true);
      expect(registry.misses).toEqual([]);
    } finally {
      await registry.close();
    }
  });

  it("refuses a tarball that no longer matches its pin, and records the miss", async () => {
    const { dir } = corpusDir();
    writeFileSync(join(dir, "cache", "demo", "1.0.0.tgz"), "tampered");
    const registry = await startRegistry({ corpus: load(dir) });
    try {
      const response = await fetch(`${registry.url}/demo/-/demo-1.0.0.tgz`);
      expect(response.status).toBe(502);
      expect(registry.misses.join()).toMatch(/does not match its pin/);
    } finally {
      await registry.close();
    }
  });

  it("records a request for a package it cannot serve, instead of answering silently", async () => {
    const { dir } = corpusDir();
    const registry = await startRegistry({ corpus: load(dir) });
    try {
      expect((await fetch(`${registry.url}/unknown-package`)).status).toBe(404);
      expect(registry.misses).toEqual(["unknown-package is not in the corpus or the fixtures"]);
    } finally {
      await registry.close();
    }
  });
});

describe("the committed corpus", () => {
  it("matches its lock, its cached tarballs and its tasks' advisories", () => {
    const report = verifyCorpus({ tasksDir: DEFAULT_TASKS_DIR });
    expect(report.problems).toEqual([]);
    expect(report.versions).toBeGreaterThan(0);
  });
});

describe("corpus paths", () => {
  it("accept npm package names and nothing that can climb out of a directory", () => {
    for (const name of ["lodash", "@types/node", "JSONStream", "a.b-c_d", "@scope/a.b"]) {
      expect([name, isPackageName(name)]).toEqual([name, true]);
    }
    for (const name of [
      "",
      "..",
      "../x",
      "a/b",
      "@scope",
      "@scope/",
      "/etc/passwd",
      ".hidden",
      String.raw`a\b`,
      "a\0b",
      "x".repeat(215),
    ]) {
      expect([name, isPackageName(name)]).toEqual([name, false]);
    }
  });

  it("accept semver versions only", () => {
    expect(isVersion("1.2.3")).toBe(true);
    expect(isVersion("1.2.3-beta.1+build.5")).toBe(true);
    for (const version of ["", "1.2", "../1.2.3", "1.2.3/../../x", "constructor"]) {
      expect([version, isVersion(version)]).toEqual([version, false]);
    }
  });

  it("refuse to build a path for a name or version that fails the check", () => {
    expect(() => packumentPath("../escape")).toThrow(/Not a package name/);
    expect(() => tarballCachePath("lodash", "../../x")).toThrow(/Not a version/);
    expect(packumentPath("@types/node")).toMatch(/@types__node\.json$/);
  });

  it("do not serve names that only exist on every object, or that traverse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-corpus-paths-"));
    made.push(dir);
    writeFileSync(
      join(dir, "lock.json"),
      JSON.stringify({ snapshotDate: "2026-01-01T00:00:00Z", packages: {} }),
    );
    const corpus = loadCorpus({ lockPath: join(dir, "lock.json") });
    for (const name of ["constructor", "__proto__", "toString", "../x", "a/b"]) {
      expect(corpus?.has(name)).toBe(false);
      expect(corpus?.packument(name, "http://127.0.0.1:1")).toBeUndefined();
      expect(corpus?.tarball(name, "1.0.0").ok).toBe(false);
    }
    expect(corpus?.tarball("lodash", "../../1.0.0").ok).toBe(false);
  });
});
