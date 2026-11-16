import { createHash } from "node:crypto";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildPackument,
  DEFAULT_REGISTRY_DIR,
  loadFixturePackages,
  resolveTime,
  startRegistry,
  type Registry,
} from "./registry.ts";
import { packDirectory } from "./tarball.ts";

function entryNames(tarball: Buffer): string[] {
  const data = gunzipSync(tarball);
  const names: string[] = [];
  for (let offset = 0; offset + 512 <= data.length;) {
    const name = data
      .subarray(offset, offset + 100)
      .toString("utf8")
      .replace(/\0.*$/s, "");
    if (!name) break;
    const size = Number.parseInt(data.subarray(offset + 124, offset + 135).toString("utf8"), 8);
    names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe("fixture registry", () => {
  let registry: Registry;
  beforeAll(async () => {
    registry = await startRegistry();
  });
  afterAll(async () => {
    await registry.close();
  });

  it("serves a packument with integrity data and tarballs that match it", async () => {
    const packument = (await (await fetch(`${registry.url}/bench-slugify`)).json()) as {
      name: string;
      "dist-tags": { latest: string };
      versions: Record<string, { dist: { tarball: string; integrity: string; shasum: string } }>;
    };
    expect(packument.name).toBe("bench-slugify");
    expect(Object.keys(packument.versions)).toEqual(["1.2.0", "1.2.3"]);
    expect(packument["dist-tags"].latest).toBe("1.2.3");

    const dist = packument.versions["1.2.3"]!.dist;
    expect(dist.tarball).toBe(`${registry.url}/bench-slugify/-/bench-slugify-1.2.3.tgz`);
    const body = Buffer.from(await (await fetch(dist.tarball)).arrayBuffer());
    expect(`sha512-${createHash("sha512").update(body).digest("base64")}`).toBe(dist.integrity);
    expect(createHash("sha1").update(body).digest("hex")).toBe(dist.shasum);
    expect(entryNames(body)).toEqual([
      "package/index.d.ts",
      "package/index.js",
      "package/package.json",
    ]);
  });

  it("is a closed world: unknown packages are 404, nothing is proxied", async () => {
    expect((await fetch(`${registry.url}/left-pad`)).status).toBe(404);
    expect((await fetch(`${registry.url}/left-pad/-/left-pad-1.3.0.tgz`)).status).toBe(404);
    expect((await fetch(`${registry.url}/bench-slugify`, { method: "POST" })).status).toBe(405);
  });

  it("flags install scripts and deprecation the way the real registry does", async () => {
    const fast = (await (await fetch(`${registry.url}/bench-fastjson`)).json()) as {
      versions: Record<string, { hasInstallScript?: boolean; scripts?: Record<string, string> }>;
    };
    expect(fast.versions["3.1.1"]?.hasInstallScript).toBe(true);
    expect(fast.versions["3.1.1"]?.scripts?.["postinstall"]).toBeTruthy();
    expect(fast.versions["3.1.0"]?.hasInstallScript).toBeUndefined();

    const legacy = (await (await fetch(`${registry.url}/bench-legacy-xml`)).json()) as {
      versions: Record<string, { deprecated?: string }>;
    };
    expect(legacy.versions["0.9.0"]?.deprecated).toMatch(/maintained/);
  });

  it("dates the 'too new' release relative to now and every other release long ago", async () => {
    const tmpl = (await (await fetch(`${registry.url}/bench-tmpl`)).json()) as {
      time: Record<string, string>;
    };
    const ageHours = (version: string) =>
      (Date.now() - Date.parse(tmpl.time[version]!)) / 3_600_000;
    expect(ageHours("2.3.2")).toBeGreaterThan(0.9);
    expect(ageHours("2.3.2")).toBeLessThan(1.5);
    expect(ageHours("2.3.0")).toBeGreaterThan(24 * 365);
  });
});

describe("registry building blocks", () => {
  it("resolves relative times and rejects nonsense", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    expect(resolveTime("now-2h", now)).toBe("2026-01-01T10:00:00.000Z");
    expect(resolveTime("2024-03-01T00:00:00.000Z", now)).toBe("2024-03-01T00:00:00.000Z");
    expect(() => resolveTime("yesterday", now)).toThrow(/Invalid registry time/);
  });

  it("packs the same bytes every time", () => {
    const dir = join(DEFAULT_REGISTRY_DIR, "bench-money", "1.5.0");
    const first = packDirectory(dir);
    expect(packDirectory(dir).integrity).toBe(first.integrity);
    expect(entryNames(first.data)).toEqual([
      "package/CHANGELOG.md",
      "package/index.d.ts",
      "package/index.js",
      "package/package.json",
    ]);
  });

  it("builds a packument for every fixture, listing every version", () => {
    const fixtures = loadFixturePackages();
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    for (const fixture of fixtures) {
      const packument = buildPackument(fixture, "http://127.0.0.1:1");
      expect(Object.keys(packument["versions"] as object)).toEqual(
        fixture.versions.map((v) => v.version),
      );
    }
  });
});
