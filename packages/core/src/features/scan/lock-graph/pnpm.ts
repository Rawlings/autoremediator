import { isRecord } from "../../../shared/guards.js";
import { parsePnpmLockDocument } from "../pnpm-lock-document.js";
import { type LockGraph, type LockNode, type LockRoot } from "./types.js";

/** `{ name: ref }` of a dependency table; the ref is a string (v5, snapshots) or `{ specifier, version }` (importers). */
function refsOf(table: unknown): Array<[string, string]> {
  if (!isRecord(table)) return [];
  const refs: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(table)) {
    const ref = isRecord(value) ? value["version"] : value;
    if (typeof ref === "string") refs.push([name, ref]);
    else if (typeof ref === "number") refs.push([name, String(ref)]);
  }
  return refs;
}

/** `name` and `version` out of a package key in any lockfile generation. */
function parseKey(key: string, generation: number): { name: string; version: string } | undefined {
  const bare = key.startsWith("/") ? key.slice(1) : key;
  if (generation < 6) {
    // v5: `name/version[_peers]`, with a scope taking two segments.
    const segments = bare.split("/");
    const nameLength = bare.startsWith("@") ? 2 : 1;
    const version = segments[nameLength]?.split("_")[0];
    return version ? { name: segments.slice(0, nameLength).join("/"), version } : undefined;
  }
  // v6, v9: `name@version(peers)`.
  const paren = bare.indexOf("(");
  const core = paren === -1 ? bare : bare.slice(0, paren);
  const at = core.lastIndexOf("@");
  return at > 0 ? { name: core.slice(0, at), version: core.slice(at + 1) } : undefined;
}

const resolveAll = (
  resolveRef: (name: string, ref: string) => string | undefined,
  entries: Array<[string, string]>,
): string[] => entries.flatMap(([name, ref]) => resolveRef(name, ref) ?? []);

/** Parse `pnpm-lock.yaml` (lockfile versions 5 to 9). */
export function parsePnpmLock(content: string): LockGraph {
  const data: unknown = parsePnpmLockDocument(content);
  if (!isRecord(data)) throw new Error("pnpm-lock.yaml is not a YAML mapping");

  const declared = data["lockfileVersion"];
  const generation =
    typeof declared === "number" || typeof declared === "string"
      ? Math.trunc(Number.parseFloat(String(declared)))
      : 9;
  const packages = isRecord(data["packages"]) ? data["packages"] : {};
  const snapshots = isRecord(data["snapshots"]) ? data["snapshots"] : {};
  // From v9 the graph lives in `snapshots` and per-package facts in `packages`; before, in `packages`.
  const table = Object.keys(snapshots).length > 0 ? snapshots : packages;

  const resolveRef = (name: string, ref: string): string | undefined => {
    if (/^(?:link|file|workspace|portal):/.test(ref)) return undefined;
    return [`${name}@${ref}`, `/${name}@${ref}`, `/${name}/${ref}`, ref, `/${ref}`].find((key) =>
      Object.hasOwn(table, key),
    );
  };

  const nodes = new Map<string, LockNode>();
  for (const [key, raw] of Object.entries(table)) {
    const entry = isRecord(raw) ? raw : {};
    const parsed = parseKey(key, generation);
    const paren = key.indexOf("(");
    const info = packages[key] ?? packages[paren === -1 ? key : key.slice(0, paren)];
    const facts = isRecord(info) ? info : {};
    const name = typeof facts["name"] === "string" ? facts["name"] : parsed?.name;
    const version = typeof facts["version"] === "string" ? facts["version"] : parsed?.version;
    if (!name || !version) continue;

    const deps = new Set<string>();
    for (const [depName, ref] of [
      ...refsOf(entry["dependencies"]),
      ...refsOf(entry["optionalDependencies"]),
    ]) {
      const target = resolveRef(depName, ref);
      if (target !== undefined) deps.add(target);
    }
    nodes.set(key, {
      id: key,
      name,
      version,
      deps: [...deps],
      ...(facts["requiresBuild"] === true || entry["requiresBuild"] === true
        ? { installScript: true }
        : {}),
    });
  }

  const importers: Record<string, unknown> = isRecord(data["importers"])
    ? data["importers"]
    : { ".": data };
  const roots: LockRoot[] = Object.entries(importers).flatMap(([workspace, raw]) => {
    if (!isRecord(raw)) return [];
    return [
      {
        workspace,
        prod: resolveAll(resolveRef, [
          ...refsOf(raw["dependencies"]),
          ...refsOf(raw["optionalDependencies"]),
        ]),
        dev: resolveAll(resolveRef, refsOf(raw["devDependencies"])),
      },
    ];
  });
  return { format: "pnpm", nodes, roots, recordsInstallScripts: true };
}
