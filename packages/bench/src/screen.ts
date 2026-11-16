/**
 * Static screen for a package tarball. Nothing is installed or run: the archive is read with caps on
 * size and entry count and every entry is judged by its path, type and first bytes.
 *
 * A published package may only enter the benchmark if it is plain JavaScript and data that npm installs
 * without running anything of the package's: no lifecycle scripts, no native build or binary, no
 * links, no paths that leave the package directory, nothing fetched from outside the registry.
 */
import { gunzipSync } from "node:zlib";

export const VIOLATION_KINDS = [
  "lifecycle-script",
  "native-build",
  "native-binary",
  "link",
  "special-file",
  "unsafe-path",
  "non-registry-dependency",
  "too-large",
  "malformed",
] as const;
export type ViolationKind = (typeof VIOLATION_KINDS)[number];

export interface Violation {
  kind: ViolationKind;
  /** Entry path inside the tarball, or `(archive)` for the archive as a whole. */
  path: string;
  detail: string;
}

export interface ScreenResult {
  ok: boolean;
  violations: Violation[];
}

export const DEFAULT_SCREEN_LIMITS = {
  maxEntries: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
};
export type ScreenLimits = typeof DEFAULT_SCREEN_LIMITS;

/**
 * Scripts npm runs when it installs a package from the registry. `prepare` is not one of them: npm
 * runs it when a package is published or installed from git or a folder, never for a registry
 * tarball, so many harmless releases declare it. The benchmark installs with --ignore-scripts too.
 */
export const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"] as const;

const MAX_REPORTED = 50;
const BLOCK = 512;
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
const NATIVE_EXTENSION = /\.(?:node|dylib|dll|exe)$|\.so(?:\.\d+)*$/i;
const NON_REGISTRY_SPEC =
  /^(?:git[+:]|github:|gitlab:|bitbucket:|gist:|https?:|file:|link:|\.{0,2}\/|[\w.-]+\/[\w.-]+(?:#.*)?$)/i;
const MACHO_OR_FAT = new Set([
  0xfe_ed_fa_ce, 0xfe_ed_fa_cf, 0xce_fa_ed_fe, 0xcf_fa_ed_fe, 0xca_fe_ba_be,
]);

interface TarEntry {
  path: string;
  type: string;
  data: Buffer;
}

function cString(buffer: Buffer, start: number, length: number): string {
  const field = buffer.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function parseOctal(field: Buffer): number | undefined {
  if ((field[0] ?? 0) & 0x80) return undefined; // base-256 sizes are far beyond every cap
  const end = field.indexOf(0);
  const text = field
    .subarray(0, end === -1 ? field.length : end)
    .toString("ascii")
    .trim();
  if (text === "") return 0;
  return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : undefined;
}

/** `path` and `linkpath` records of a pax extended header. */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(position, space).toString("ascii"), 10);
    if (!Number.isInteger(length) || length <= space - position + 1) break;
    const record = data.subarray(space + 1, position + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    position += length;
  }
  return records;
}

function checksumOk(block: Buffer): boolean {
  const stored = parseOctal(block.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  return stored === sum;
}

function readEntries(
  tar: Buffer,
  limits: ScreenLimits,
  add: (violation: Violation) => void,
): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let total = 0;
  let count = 0;
  let pendingPath: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    count += 1;
    if (count > limits.maxEntries) {
      add({
        kind: "too-large",
        path: "(archive)",
        detail: `more than ${limits.maxEntries} entries`,
      });
      break;
    }
    if (!checksumOk(block)) {
      add({
        kind: "malformed",
        path: "(archive)",
        detail: `bad header checksum at byte ${offset}`,
      });
      break;
    }
    const size = parseOctal(block.subarray(124, 136));
    if (size === undefined || size > limits.maxTotalBytes) {
      add({
        kind: "too-large",
        path: cString(block, 0, 100),
        detail: "entry size is out of range",
      });
      break;
    }
    const start = offset + BLOCK;
    if (start + size > tar.length) {
      add({ kind: "malformed", path: cString(block, 0, 100), detail: "entry is cut off" });
      break;
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      add({
        kind: "too-large",
        path: "(archive)",
        detail: `contents exceed ${limits.maxTotalBytes} bytes`,
      });
      break;
    }
    const data = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    const flag = block[156] ?? 0;
    const type = flag === 0 ? "0" : String.fromCodePoint(flag);
    let name = cString(block, 0, 100);
    if (cString(block, 257, 5) === "ustar") {
      const prefix = cString(block, 345, 155);
      if (prefix !== "") name = `${prefix}/${name}`;
    }
    if (type === "x") {
      pendingPath = paxRecords(data).get("path") ?? pendingPath;
    } else if (type === "L") {
      pendingPath = cString(data, 0, data.length);
    } else if (type !== "g" && type !== "K") {
      entries.push({ path: pendingPath ?? name, type, data });
      pendingPath = undefined;
    }
  }
  return entries;
}

function pathProblem(path: string): string | undefined {
  if (path.includes("\0")) return "contains a NUL byte";
  if (/^[\\/]|^[A-Za-z]:/.test(path)) return "is absolute";
  if (path.split(/[\\/]/).includes("..")) return "leaves the package directory";
  return undefined;
}

function nativeMagic(data: Buffer): string | undefined {
  if (data.length >= 4) {
    const magic = data.readUInt32BE(0);
    if (magic === 0x7f_45_4c_46) return "ELF";
    if (MACHO_OR_FAT.has(magic)) return "Mach-O or compiled class";
  }
  if (data.length >= 0x40 && data[0] === 0x4d && data[1] === 0x5a) {
    const peOffset = data.readUInt32LE(0x3c);
    if (peOffset + 4 <= data.length && data.readUInt32BE(peOffset) === 0x50_45_00_00) return "PE";
  }
  return undefined;
}

function checkManifest(
  path: string,
  data: Buffer,
  nested: boolean,
  limits: ScreenLimits,
  add: (violation: Violation) => void,
): void {
  if (data.length > limits.maxManifestBytes) {
    add({ kind: "too-large", path, detail: "package.json is unreasonably large" });
    return;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(data.toString("utf8"));
  } catch {
    // A manifest that does not parse is reported, never trusted, whether or not it is nested.
    add({ kind: "malformed", path, detail: "package.json is not valid JSON" });
    return;
  }
  if (typeof manifest !== "object" || manifest === null) {
    add({ kind: "malformed", path, detail: "package.json is not an object" });
    return;
  }
  const fields = manifest as Record<string, unknown>;
  const scripts = fields["scripts"];
  if (typeof scripts === "object" && scripts !== null) {
    for (const script of LIFECYCLE_SCRIPTS) {
      if (script in scripts) {
        add({ kind: "lifecycle-script", path, detail: `declares the ${script} script` });
      }
    }
  }
  if (fields["gypfile"] === true) {
    add({ kind: "native-build", path, detail: "gypfile is true, so npm would run node-gyp" });
  }
  if (nested) return;
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = fields[field];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec === "string" && NON_REGISTRY_SPEC.test(spec)) {
        add({
          kind: "non-registry-dependency",
          path,
          detail: `${field}.${name} is "${spec}", which is not fetched from the registry`,
        });
      }
    }
  }
}

function checkEntry(
  entry: TarEntry,
  limits: ScreenLimits,
  add: (violation: Violation) => void,
): boolean {
  const problem = pathProblem(entry.path);
  if (problem) add({ kind: "unsafe-path", path: entry.path, detail: `path ${problem}` });
  if (entry.type === "1" || entry.type === "2") {
    add({ kind: "link", path: entry.path, detail: "is a symbolic or hard link" });
    return false;
  }
  if (entry.type === "5") return false;
  if (entry.type !== "0") {
    add({ kind: "special-file", path: entry.path, detail: `has entry type "${entry.type}"` });
    return false;
  }
  if (entry.data.length > limits.maxFileBytes) {
    add({ kind: "too-large", path: entry.path, detail: `is ${entry.data.length} bytes` });
    return false;
  }
  const relative = entry.path.split("/").slice(1).join("/");
  const base = relative.slice(relative.lastIndexOf("/") + 1);
  if (base === "binding.gyp") {
    add({ kind: "native-build", path: entry.path, detail: "binding.gyp makes npm run node-gyp" });
  }
  if (NATIVE_EXTENSION.test(base)) {
    add({ kind: "native-binary", path: entry.path, detail: "has a native binary extension" });
  }
  const magic = nativeMagic(entry.data);
  if (magic) {
    add({ kind: "native-binary", path: entry.path, detail: `starts like a ${magic} file` });
  }
  return base === "package.json";
}

/** Screen a gzip-compressed package tarball. Never throws on bad input: it reports it. */
export function screenTarball(
  tarball: Buffer,
  limits: ScreenLimits = DEFAULT_SCREEN_LIMITS,
): ScreenResult {
  const violations: Violation[] = [];
  const add = (violation: Violation): void => {
    if (violations.length < MAX_REPORTED) violations.push(violation);
  };
  let tar: Buffer;
  try {
    if (tarball.length > limits.maxTotalBytes) throw new RangeError("compressed size");
    tar = gunzipSync(tarball, { maxOutputLength: limits.maxTotalBytes + BLOCK * 2 });
  } catch (error) {
    const tooLarge = error instanceof RangeError;
    add({
      kind: tooLarge ? "too-large" : "malformed",
      path: "(archive)",
      detail: tooLarge ? `expands beyond ${limits.maxTotalBytes} bytes` : "is not a gzip archive",
    });
    return { ok: false, violations };
  }

  let sawRootManifest = false;
  for (const entry of readEntries(tar, limits, add)) {
    if (!checkEntry(entry, limits, add)) continue;
    const relative = entry.path.split("/").slice(1).join("/");
    const root = relative === "package.json";
    const bundled = relative.includes("node_modules/") && relative.endsWith("/package.json");
    if (root) sawRootManifest = true;
    if (root || bundled) checkManifest(entry.path, entry.data, !root, limits, add);
  }
  if (!sawRootManifest && violations.length === 0) {
    add({ kind: "malformed", path: "(archive)", detail: "has no package.json at its root" });
  }
  return { ok: violations.length === 0, violations };
}
