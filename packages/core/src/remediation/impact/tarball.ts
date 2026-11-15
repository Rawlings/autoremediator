/**
 * Read an npm tarball into memory without ever writing it to disk.
 *
 * Nothing is extracted, so a hostile archive cannot write outside a directory, plant a symlink or
 * be executed. The reader still refuses what no real package contains: absolute or `..` paths,
 * corrupt headers, unreasonable sizes and entry counts (zip bombs). Links and device entries are
 * skipped and counted, never followed.
 */
import { gunzipSync } from "node:zlib";

export interface TarballLimits {
  /** Largest allowed size of the decompressed archive. */
  maxUnpackedBytes: number;
  /** Largest allowed number of archive entries. */
  maxEntries: number;
  /** Source files larger than this are skipped, not read. */
  maxFileBytes: number;
  /** Largest total size of retained source text. */
  maxRetainedBytes: number;
  /** Largest number of retained source files. */
  maxRetainedFiles: number;
}

export const DEFAULT_TARBALL_LIMITS: TarballLimits = {
  maxUnpackedBytes: 256 * 1024 * 1024,
  maxEntries: 50_000,
  maxFileBytes: 4 * 1024 * 1024,
  maxRetainedBytes: 48 * 1024 * 1024,
  maxRetainedFiles: 6000,
};

export interface PackageFiles {
  /** Retained source files by package-relative path (`lib/index.js`), UTF-8 text. */
  files: Map<string, string>;
  /** Parsed root `package.json`. */
  manifest: Record<string, unknown>;
  stats: {
    entries: number;
    unpackedBytes: number;
    skippedLinks: number;
    skippedLarge: number;
    skippedOther: number;
  };
}

export class TarballError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TarballError";
  }
}

const BLOCK = 512;
const SOURCE_PATTERN = /\.(?:[cm]?[jt]sx?|d\.[cm]?ts)$/i;
const MINIFIED_PATTERN = /\.min\.[cm]?js$/i;

function readString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readOctal(buffer: Buffer, start: number, length: number, field: string): number {
  // A set high bit means base-256 encoding, used only for sizes beyond 8 GiB.
  if (((buffer[start] ?? 0) & 0x80) !== 0) {
    throw new TarballError(`Tarball entry has an oversized ${field}`);
  }
  const text = readString(buffer, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarballError(`Tarball header has a corrupt ${field}`);
  return Number.parseInt(text, 8);
}

function verifyChecksum(header: Buffer): void {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (sum !== readOctal(header, 148, 8, "checksum")) {
    throw new TarballError("Tarball header checksum mismatch (corrupt or malicious archive)");
  }
}

function parsePax(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

/**
 * Validate an entry path and strip the leading directory (`package/`) the way npm does.
 * Throws for a path that is absolute, contains `..`, a NUL byte or a drive letter.
 */
export function normalizeEntryPath(raw: string): string {
  if (raw.includes("\0")) throw new TarballError("Tarball entry path contains a NUL byte");
  const unified = raw.replaceAll("\\", "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) {
    throw new TarballError(`Tarball entry has an absolute path: ${JSON.stringify(raw)}`);
  }
  const segments = unified.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new TarballError(`Tarball entry escapes the package directory: ${JSON.stringify(raw)}`);
  }
  return segments.slice(1).join("/");
}

/** Decompress and read a package tarball; see the module comment for what is refused. */
export function readPackageTarball(
  bytes: Uint8Array,
  limits: TarballLimits = DEFAULT_TARBALL_LIMITS,
): PackageFiles {
  let archive: Buffer;
  try {
    archive = gunzipSync(bytes, { maxOutputLength: limits.maxUnpackedBytes });
  } catch (error) {
    const tooLarge =
      error instanceof RangeError ||
      (error as NodeJS.ErrnoException | undefined)?.code === "ERR_BUFFER_TOO_LARGE";
    throw new TarballError(
      tooLarge
        ? `Tarball expands beyond ${limits.maxUnpackedBytes} bytes (refusing a possible zip bomb)`
        : "Tarball is not a valid gzip archive",
      { cause: error },
    );
  }

  const files = new Map<string, string>();
  const stats: PackageFiles["stats"] = {
    entries: 0,
    unpackedBytes: archive.length,
    skippedLinks: 0,
    skippedLarge: 0,
    skippedOther: 0,
  };
  let manifestText: string | undefined;
  let retainedBytes = 0;
  let paxNext: Record<string, string> = {};
  let longName: string | undefined;
  let offset = 0;

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    verifyChecksum(header);

    const size = readOctal(header, 124, 12, "size");
    const type = String.fromCodePoint(header[156] || 0x30);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new TarballError("Tarball is truncated");
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      paxNext = parsePax(archive.subarray(dataStart, dataEnd));
      continue;
    }
    if (type === "g" || type === "K") continue;
    if (type === "L") {
      longName = readString(archive, dataStart, size);
      continue;
    }

    stats.entries++;
    if (stats.entries > limits.maxEntries) {
      throw new TarballError(`Tarball has more than ${limits.maxEntries} entries`);
    }

    const prefix = readString(header, 345, 155);
    const baseName = readString(header, 0, 100);
    const rawPath = paxNext.path ?? longName ?? (prefix ? `${prefix}/${baseName}` : baseName);
    paxNext = {};
    longName = undefined;
    // Validated for every entry type, so a hostile name is refused even on a link or directory.
    const path = normalizeEntryPath(rawPath);

    if (type === "1" || type === "2") {
      stats.skippedLinks++;
      continue;
    }
    if (type === "5") continue;
    if (type !== "0") {
      stats.skippedOther++;
      continue;
    }
    if (path === "") continue;
    if (path.split("/").includes("node_modules")) continue;

    const isManifest = path === "package.json";
    if (!isManifest && (!SOURCE_PATTERN.test(path) || MINIFIED_PATTERN.test(path))) continue;
    if (size > limits.maxFileBytes) {
      stats.skippedLarge++;
      continue;
    }
    if (!isManifest) {
      if (files.size >= limits.maxRetainedFiles || retainedBytes + size > limits.maxRetainedBytes) {
        stats.skippedLarge++;
        continue;
      }
      retainedBytes += size;
    }
    const text = archive.subarray(dataStart, dataEnd).toString("utf8");
    if (isManifest) manifestText = text;
    else files.set(path, text);
  }

  if (manifestText === undefined) throw new TarballError("Tarball has no root package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new TarballError("Tarball package.json is not valid JSON", { cause: error });
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new TarballError("Tarball package.json is not an object");
  }
  return { files, manifest: manifest as Record<string, unknown>, stats };
}
