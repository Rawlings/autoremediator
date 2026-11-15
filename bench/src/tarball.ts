/**
 * Minimal, deterministic npm tarball writer: a gzip-compressed ustar archive whose entries live
 * under `package/`, which is what npm expects. Fixed mtime and ownership, so the same fixture always
 * produces the same bytes and the same integrity hash.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const BLOCK = 512;

function field(value: string, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  buffer.write(value, 0, length, "utf8");
  return buffer;
}

function octal(value: number, length: number): Buffer {
  return field(`${value.toString(8).padStart(length - 1, "0")}\0`, length);
}

function header(name: string, size: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tarball entry name too long: ${name}`);
  const block = Buffer.alloc(BLOCK);
  field(name, 100).copy(block, 0);
  octal(0o644, 8).copy(block, 100);
  octal(0, 8).copy(block, 108);
  octal(0, 8).copy(block, 116);
  octal(size, 12).copy(block, 124);
  octal(0, 12).copy(block, 136);
  block.fill(0x20, 148, 156); // the checksum is computed with this field as spaces
  block.write("0", 156);
  field("ustar\0", 6).copy(block, 257);
  field("00", 2).copy(block, 263);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  field(`${checksum.toString(8).padStart(6, "0")}\0 `, 8).copy(block, 148);
  return block;
}

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).toSorted()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

export interface Tarball {
  data: Buffer;
  /** `sha512-<base64>`, as npm records it in `dist.integrity` and the lockfile. */
  integrity: string;
  /** Hex SHA-1, as npm records it in `dist.shasum`. */
  shasum: string;
}

/** Pack a directory as an npm tarball (entries under `package/`). */
export function packDirectory(dir: string): Tarball {
  const parts: Buffer[] = [];
  for (const file of files(dir)) {
    const content = readFileSync(file);
    parts.push(
      header(`package/${relative(dir, file).split("\\").join("/")}`, content.length),
      content,
    );
    const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  // zlib writes a zero mtime in the gzip header, so the bytes do not depend on when this runs.
  const data = gzipSync(Buffer.concat(parts), { level: 9 });
  return {
    data,
    integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`,
    shasum: createHash("sha1").update(data).digest("hex"),
  };
}
