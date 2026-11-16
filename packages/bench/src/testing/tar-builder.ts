/**
 * Builds small tarballs for tests, including hostile ones the benchmark's own writer (`tarball.ts`)
 * would never produce: links, `..` paths, pax and GNU long-name headers, a corrupt checksum.
 */
import { gzipSync } from "node:zlib";

const BLOCK = 512;

export interface TestEntry {
  name: string;
  /** Tar type flag: "0" file (default), "5" directory, "1" hard link, "2" symlink, "x" pax, "L" GNU long name. */
  type?: string;
  data?: Buffer | string;
  linkname?: string;
  /** Write a wrong checksum. */
  corrupt?: boolean;
}

function put(block: Buffer, value: string, start: number, length: number): void {
  block.write(value, start, length, "utf8");
}

function entryBytes(entry: TestEntry): Buffer {
  const data = Buffer.from(entry.data ?? "");
  const block = Buffer.alloc(BLOCK);
  put(block, entry.name, 0, 100);
  put(block, "0000644\0", 100, 8);
  put(block, "0000000\0", 108, 8);
  put(block, "0000000\0", 116, 8);
  put(block, `${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  put(block, "00000000000\0", 136, 12);
  block.fill(0x20, 148, 156);
  put(block, entry.type ?? "0", 156, 1);
  put(block, entry.linkname ?? "", 157, 100);
  put(block, "ustar\0", 257, 6);
  put(block, "00", 263, 2);
  const sum = block.reduce((total, byte) => total + byte, 0) + (entry.corrupt ? 1 : 0);
  put(block, `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
  return Buffer.concat([block, data, Buffer.alloc(padding)]);
}

/** One pax record: `<length> <key>=<value>\n`, where the length counts itself. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
  return `${length}${body}`;
}

export function tarball(entries: readonly TestEntry[]): Buffer {
  return gzipSync(
    Buffer.concat([...entries.map((entry) => entryBytes(entry)), Buffer.alloc(BLOCK * 2)]),
  );
}

/** A manifest as JSON text. */
export function manifestOf(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: "demo", version: "1.0.0", ...fields });
}

/** A clean package: manifest, code and types under `package/`. */
export function cleanEntries(manifest: Record<string, unknown> = {}): TestEntry[] {
  return [
    { name: "package/package.json", data: manifestOf(manifest) },
    { name: "package/index.js", data: "module.exports = () => 1;\n" },
    { name: "package/index.d.ts", data: "declare const f: () => number;\nexport = f;\n" },
    { name: "package/README.md", data: "Run `npm run postinstall` yourself if you like.\n" },
  ];
}
