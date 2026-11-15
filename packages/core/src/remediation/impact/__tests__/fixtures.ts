/** Test helpers: build tar archives and in-memory package versions without any network. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import type { PackageSource } from "../types.js";

export interface TarEntry {
  path: string;
  content?: string | Buffer;
  /** Tar type flag: `0` file (default), `2` symlink, `1` hardlink, `5` directory, `x` pax header. */
  type?: string;
  linkname?: string;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(entry.path.slice(0, 100), 0, "utf8");
  block.write(octal(0o644, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(0, 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(entry.type ?? "0", 156, "ascii");
  if (entry.linkname) block.write(entry.linkname, 157, "utf8");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

/** A raw (uncompressed) tar archive. */
export function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    parts.push(header(entry, content.length), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function tgz(entries: TarEntry[]): Uint8Array {
  return gzipSync(tar(entries));
}

/** An npm-style tarball: every path under `package/`. */
export function packageTarball(
  files: Record<string, string>,
  manifest: Record<string, unknown>,
): Uint8Array {
  return tgz([
    { path: "package/package.json", content: JSON.stringify(manifest) },
    ...Object.entries(files).map(([path, content]) => ({ path: `package/${path}`, content })),
  ]);
}

/** A package version held in memory. */
export function pkg(
  version: string,
  files: Record<string, string>,
  manifest: Record<string, unknown> = {},
  name = "fixture-pkg",
): PackageSource {
  return {
    name,
    version,
    files: new Map(Object.entries(files)),
    manifest: { name, version, ...manifest },
    integrityVerified: true,
  };
}

const created: string[] = [];

/** Remove every project directory made by `project`. Call from `afterEach`. */
export function cleanupProjects(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A project directory with the given files, for usage scanning. */
export function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "autoremediator-impact-"));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}
