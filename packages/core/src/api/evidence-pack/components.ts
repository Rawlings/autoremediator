import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

import { stripJsonc } from "../../scanner/lock-graph/bun.js";
import { isRecord } from "../../scanner/lock-graph/types.js";

/** `pkg:npm/%40scope/name@1.2.3`: the Package URL of an npm package (purl spec, type `npm`). */
export function npmPurl(name: string, version: string): string {
  const encoded = name.startsWith("@")
    ? `%40${name
        .slice(1)
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

/** CycloneDX models `@scope/name` as group `@scope` and name `name`. */
export function splitName(name: string): { group?: string; name: string } {
  const slash = name.startsWith("@") ? name.indexOf("/") : -1;
  return slash === -1 ? { name } : { group: name.slice(0, slash), name: name.slice(slash + 1) };
}

export interface CycloneDxHash {
  alg: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
  content: string;
}

const SRI_ALGORITHMS: Record<string, CycloneDxHash["alg"]> = {
  sha1: "SHA-1",
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
};
const HEX_LENGTH: Record<CycloneDxHash["alg"], number> = {
  "SHA-1": 40,
  "SHA-256": 64,
  "SHA-384": 96,
  "SHA-512": 128,
};
const STRENGTH = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"] as const;

/**
 * Turn a Subresource Integrity string from a lockfile (`sha512-<base64>`, possibly several
 * separated by spaces) into the strongest CycloneDX hash it holds. Anything that does not decode to
 * a digest of the right length is dropped rather than guessed at.
 */
export function hashFromIntegrity(integrity: string): CycloneDxHash | undefined {
  let best: CycloneDxHash | undefined;
  for (const token of integrity.trim().split(/\s+/)) {
    const dash = token.indexOf("-");
    const alg = dash > 0 ? SRI_ALGORITHMS[token.slice(0, dash).toLowerCase()] : undefined;
    if (!alg) continue;
    const content = Buffer.from(token.slice(dash + 1).split("?")[0] ?? "", "base64").toString(
      "hex",
    );
    if (content.length !== HEX_LENGTH[alg]) continue;
    if (!best || STRENGTH.indexOf(alg) > STRENGTH.indexOf(best.alg)) best = { alg, content };
  }
  return best;
}

/** SPDX identifiers common in npm; anything else is reported by name, never as an invented id. */
const SPDX_IDS = [
  "0BSD",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "Apache-2.0",
  "Artistic-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "EPL-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "ISC",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
  "Unlicense",
  "WTFPL",
  "Zlib",
];
const SPDX_BY_LOWER = new Map(SPDX_IDS.map((id) => [id.toLowerCase(), id]));

export type CycloneDxLicenseChoice =
  | { license: { id: string } }
  | { license: { name: string } }
  | { expression: string };

/**
 * The CycloneDX `licenses` entry for a license string from a lockfile or `package.json`. A single
 * known SPDX id becomes `id`; an expression whose every operand is known becomes `expression`;
 * everything else (including `SEE LICENSE IN ...`) is kept verbatim as a `name`.
 */
export function licenseChoice(raw: string): CycloneDxLicenseChoice | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  const single = SPDX_BY_LOWER.get(text.toLowerCase());
  if (single) return { license: { id: single } };
  if (/\s(?:OR|AND|WITH)\s/.test(text)) {
    const operands = text.replaceAll(/[()]/g, " ").split(/\s+(?:OR|AND|WITH)\s+|\s+/);
    const known = operands
      .filter((operand) => operand !== "" && !["OR", "AND", "WITH"].includes(operand))
      .every((operand) => SPDX_BY_LOWER.has(operand.toLowerCase().replace(/\+$/, "")));
    if (known) return { expression: text };
  }
  return { license: { name: text } };
}

/** What a lockfile (or the installed copy) says about one locked package, keyed by `name@version`. */
export interface LockedPackageFacts {
  integrity?: string;
  license?: string;
}

/** `name@version` key of a package fact. */
export const factKey = (name: string, version: string): string => `${name}@${version}`;

function pnpmKey(key: string): { name: string; version: string } | undefined {
  const bare = key.startsWith("/") ? key.slice(1) : key;
  const paren = bare.indexOf("(");
  const core = paren === -1 ? bare : bare.slice(0, paren);
  const at = core.lastIndexOf("@");
  if (at > 0) return { name: core.slice(0, at), version: core.slice(at + 1) };
  // lockfile v5: `name/version[_peers]`
  const segments = core.split("/");
  const nameLength = core.startsWith("@") ? 2 : 1;
  const version = segments[nameLength]?.split("_")[0];
  return version ? { name: segments.slice(0, nameLength).join("/"), version } : undefined;
}

function npmName(path: string): string | undefined {
  const marker = "node_modules/";
  const at = path.lastIndexOf(marker);
  return at === -1 ? undefined : path.slice(at + marker.length);
}

function fromNpm(content: string, facts: Map<string, LockedPackageFacts>): void {
  const data: unknown = JSON.parse(content);
  if (!isRecord(data)) return;
  const record = (name: string, entry: Record<string, unknown>): void => {
    const version = entry["version"];
    if (typeof version !== "string") return;
    const found = facts.get(factKey(name, version)) ?? {};
    if (typeof entry["integrity"] === "string") found.integrity ??= entry["integrity"];
    if (typeof entry["license"] === "string") found.license ??= entry["license"];
    facts.set(factKey(name, version), found);
  };
  if (isRecord(data["packages"])) {
    for (const [path, entry] of Object.entries(data["packages"])) {
      if (!isRecord(entry) || entry["link"] === true) continue;
      const name = typeof entry["name"] === "string" ? entry["name"] : npmName(path);
      if (name) record(name, entry);
    }
  } else if (isRecord(data["dependencies"])) {
    const walk = (tree: Record<string, unknown>): void => {
      for (const [name, entry] of Object.entries(tree)) {
        if (!isRecord(entry)) continue;
        record(name, entry);
        if (isRecord(entry["dependencies"])) walk(entry["dependencies"]);
      }
    };
    walk(data["dependencies"]);
  }
}

function fromPnpm(content: string, facts: Map<string, LockedPackageFacts>): void {
  const data: unknown = YAML.parse(content);
  if (!isRecord(data) || !isRecord(data["packages"])) return;
  for (const [key, entry] of Object.entries(data["packages"])) {
    if (!isRecord(entry)) continue;
    const parsed = pnpmKey(key);
    const resolution = entry["resolution"];
    if (!parsed || !isRecord(resolution) || typeof resolution["integrity"] !== "string") continue;
    const name = typeof entry["name"] === "string" ? entry["name"] : parsed.name;
    const version = typeof entry["version"] === "string" ? entry["version"] : parsed.version;
    facts.set(factKey(name, version), { integrity: resolution["integrity"] });
  }
}

/** Yarn classic only: berry's `checksum` is not a Subresource Integrity digest and is not used. */
function fromYarn(content: string, facts: Map<string, LockedPackageFacts>): void {
  let names: string[] = [];
  let version: string | undefined;
  const flush = (integrity: string): void => {
    if (!version) return;
    for (const name of names) facts.set(factKey(name, version), { integrity });
  };
  for (const raw of content.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.startsWith("#")) continue;
    if (!raw.startsWith(" ")) {
      names = raw
        .replace(/:$/, "")
        .replaceAll('"', "")
        .split(",")
        .map((descriptor) => descriptor.trim())
        .flatMap((descriptor) => {
          const at = descriptor.indexOf("@", 1);
          return at > 0 ? [descriptor.slice(0, at)] : [];
        });
      version = undefined;
      continue;
    }
    const line = raw.trim();
    const versionMatch = /^version:?\s+"?([^"\s]+)"?$/.exec(line);
    if (versionMatch?.[1]) version = versionMatch[1];
    const integrityMatch = /^integrity\s+(\S+)$/.exec(line);
    if (integrityMatch?.[1]) flush(integrityMatch[1]);
  }
}

function fromBun(content: string, facts: Map<string, LockedPackageFacts>): void {
  const data: unknown = JSON.parse(stripJsonc(content));
  if (!isRecord(data) || !isRecord(data["packages"])) return;
  for (const entry of Object.values(data["packages"])) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const ident = entry[0];
    const at = ident.indexOf("@", 1);
    if (at <= 0 || ident.includes("@workspace:")) continue;
    const spec = ident.slice(at + 1);
    const version = spec.startsWith("npm:") ? spec.slice(spec.lastIndexOf("@") + 1) : spec;
    const integrity = entry.find(
      (part, index) => index >= 3 && typeof part === "string" && /^sha\d+-/.test(part),
    );
    if (typeof integrity === "string")
      facts.set(factKey(ident.slice(0, at), version), { integrity });
  }
}

/**
 * Integrity digests (and, for npm lockfiles, licenses) the lockfile records, by `name@version`.
 * Read from the lockfile text alone; a lockfile that cannot be read yields nothing.
 */
export function readLockFacts(lockfile: string, content: string): Map<string, LockedPackageFacts> {
  const facts = new Map<string, LockedPackageFacts>();
  try {
    if (lockfile === "package-lock.json" || lockfile === "npm-shrinkwrap.json")
      fromNpm(content, facts);
    else if (lockfile === "pnpm-lock.yaml") fromPnpm(content, facts);
    else if (lockfile === "yarn.lock") fromYarn(content, facts);
    else if (lockfile === "bun.lock") fromBun(content, facts);
  } catch {
    // An unreadable lockfile is already reported by the lock-graph reader; facts are optional.
  }
  return facts;
}

/** The `license` an installed copy declares, when `node_modules` has it. */
export function installedLicense(cwd: string, name: string, version: string): string | undefined {
  const file = join(cwd, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(file)) return undefined;
  try {
    const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(manifest) || manifest["version"] !== version) return undefined;
    const license = manifest["license"];
    if (typeof license === "string") return license;
    if (isRecord(license) && typeof license["type"] === "string") return license["type"];
    return undefined;
  } catch {
    return undefined;
  }
}
