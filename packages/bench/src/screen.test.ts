import { describe, expect, it } from "vitest";

import { loadFixturePackages } from "./registry.ts";
import { screenTarball, type ViolationKind } from "./screen.ts";
import {
  cleanEntries,
  manifestOf,
  paxRecord,
  tarball,
  type TestEntry,
} from "./testing/tar-builder.ts";

function kinds(entries: readonly TestEntry[], limits?: Parameters<typeof screenTarball>[1]) {
  return screenTarball(tarball(entries), limits).violations.map((violation) => violation.kind);
}

function withManifest(manifest: Record<string, unknown>): TestEntry[] {
  return [
    { name: "package/package.json", data: manifestOf(manifest) },
    { name: "package/index.js", data: "" },
  ];
}

describe("screenTarball", () => {
  it("accepts a plain package, even one that talks about install scripts in its README", () => {
    const result = screenTarball(
      tarball(cleanEntries({ bin: { demo: "index.js" }, dependencies: { semver: "^7.0.0" } })),
    );
    expect(result).toEqual({ ok: true, violations: [] });
  });

  it.each(["preinstall", "install", "postinstall"])("rejects a %s script", (script) => {
    expect(kinds(withManifest({ scripts: { [script]: "node x.js" } }))).toEqual([
      "lifecycle-script",
    ]);
  });

  it("allows scripts npm never runs when it installs from the registry", () => {
    const scripts = { test: "node --test", build: "tsc", prepare: "npm run build", prepack: "x" };
    expect(kinds(withManifest({ scripts }))).toEqual([]);
  });

  it("rejects a native build marked in the manifest or by binding.gyp", () => {
    expect(kinds(withManifest({ gypfile: true }))).toEqual(["native-build"]);
    expect(kinds([...cleanEntries(), { name: "package/binding.gyp", data: "{}" }])).toEqual([
      "native-build",
    ]);
  });

  it.each(["build/addon.node", "lib/x.dylib", "bin/tool.exe", "lib/libx.so.1", "w/y.dll"])(
    "rejects a native file by extension: %s",
    (path) => {
      expect(kinds([...cleanEntries(), { name: `package/${path}`, data: "x" }])).toEqual([
        "native-binary",
      ]);
    },
  );

  it("rejects native files by their first bytes even when named like text", () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    const macho = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);
    const pe = Buffer.alloc(0x80);
    pe.write("MZ", 0);
    pe.writeUInt32LE(0x40, 0x3c);
    pe.write("PE\0\0", 0x40);
    for (const data of [elf, macho, pe]) {
      expect(kinds([...cleanEntries(), { name: "package/data.txt", data }])).toEqual([
        "native-binary",
      ]);
    }
  });

  it("does not mistake a text file that starts with MZ for a program", () => {
    expect(
      kinds([...cleanEntries(), { name: "package/notes.txt", data: "MZ is a prefix\n" }]),
    ).toEqual([]);
  });

  it("rejects symbolic and hard links", () => {
    expect(
      kinds([...cleanEntries(), { name: "package/link", type: "2", linkname: "/etc/passwd" }]),
    ).toEqual(["link"]);
    expect(
      kinds([...cleanEntries(), { name: "package/hard", type: "1", linkname: "package/index.js" }]),
    ).toEqual(["link"]);
  });

  it("rejects device and fifo entries", () => {
    expect(kinds([...cleanEntries(), { name: "package/dev", type: "3" }])).toEqual([
      "special-file",
    ]);
    expect(kinds([...cleanEntries(), { name: "package/pipe", type: "6" }])).toEqual([
      "special-file",
    ]);
  });

  it.each([
    "package/../evil.js",
    "/etc/cron.d/x",
    "C:/Windows/x.js",
    String.raw`package\..\x.js`,
    "package/a/../../b",
  ])("rejects a path that leaves the package: %s", (name) => {
    expect(kinds([...cleanEntries(), { name, data: "x" }])).toContain("unsafe-path");
  });

  it("rejects a path hidden in a pax header or a GNU long-name header", () => {
    const pax = [
      { name: "package/pax", type: "x", data: paxRecord("path", "package/../../escaped.js") },
      { name: "package/innocent.js", data: "x" },
    ];
    expect(kinds([...cleanEntries(), ...pax])).toContain("unsafe-path");
    const gnu = [
      { name: "././@LongLink", type: "L", data: "package/../../escaped.js\0" },
      { name: "package/innocent.js", data: "x" },
    ];
    expect(kinds([...cleanEntries(), ...gnu])).toContain("unsafe-path");
  });

  it("looks inside bundled dependencies for install scripts", () => {
    const bundled = [
      ...cleanEntries(),
      {
        name: "package/node_modules/dep/package.json",
        data: manifestOf({ scripts: { postinstall: "node x.js" } }),
      },
    ];
    expect(kinds(bundled)).toEqual(["lifecycle-script"]);
  });

  it("ignores example manifests that are not bundled dependencies", () => {
    const example = [
      ...cleanEntries(),
      {
        name: "package/examples/app/package.json",
        data: manifestOf({ scripts: { postinstall: "node x.js" } }),
      },
    ];
    expect(kinds(example)).toEqual([]);
  });

  it.each([
    "git+https://example.invalid/x.git",
    "github:owner/repo",
    "https://example.invalid/x.tgz",
    "file:../x",
    "owner/repo",
    "owner/repo#main",
  ])("rejects a dependency that is not fetched from the registry: %s", (spec) => {
    expect(kinds(withManifest({ dependencies: { thing: spec } }))).toEqual([
      "non-registry-dependency",
    ]);
  });

  it("accepts registry ranges and npm aliases", () => {
    const dependencies = {
      a: "^1.2.3",
      b: ">=1 <3",
      c: "1.x || 2.x",
      d: "npm:@scope/other@^2",
      e: "latest",
    };
    expect(kinds(withManifest({ dependencies }))).toEqual([]);
  });

  it("enforces the caps on entries, file size and expansion", () => {
    const limits = {
      maxEntries: 5,
      maxFileBytes: 100,
      maxTotalBytes: 4096,
      maxManifestBytes: 1024,
    };
    const many = [...cleanEntries(), { name: "package/a", data: "x" }, { name: "package/b" }];
    expect(kinds(many, limits)).toContain("too-large");
    expect(
      kinds([...cleanEntries(), { name: "package/big.js", data: "x".repeat(200) }], limits),
    ).toContain("too-large");
    expect(kinds([{ name: "package/package.json", data: "x".repeat(10_000) }], limits)).toContain(
      "too-large",
    );
  });

  it("reports damage instead of throwing", () => {
    const kindOf = (buffer: Buffer): ViolationKind | undefined =>
      screenTarball(buffer).violations[0]?.kind;
    expect(kindOf(Buffer.from("not a gzip archive"))).toBe("malformed");
    expect(kindOf(tarball([{ name: "package/package.json", data: "{}", corrupt: true }]))).toBe(
      "malformed",
    );
    expect(kindOf(tarball([{ name: "package/package.json", data: "{nope" }]))).toBe("malformed");
    expect(kindOf(tarball([{ name: "package/index.js", data: "x" }]))).toBe("malformed");
  });
});

describe("the benchmark's own fixture packages", () => {
  it("are all clean except the install-script trap, and the screen sees that one", () => {
    const flagged: Record<string, ViolationKind[]> = {};
    for (const fixture of loadFixturePackages()) {
      for (const version of fixture.versions) {
        const kindsFound = screenTarball(version.tarball.data).violations.map((v) => v.kind);
        if (kindsFound.length > 0) flagged[`${fixture.name}@${version.version}`] = kindsFound;
      }
    }
    expect(flagged).toEqual({ "bench-fastjson@3.1.1": ["lifecycle-script"] });
  });
});
