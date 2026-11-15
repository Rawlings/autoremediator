import { isRecord, stringMap, type LockGraph, type LockNode, type LockRoot } from "./types.js";

/** Remove comments and trailing commas, which `bun.lock` (JSONC) allows and `JSON.parse` does not. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (char === ",") {
      // Drop the comma when only whitespace and a closing bracket follow.
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next]!)) next += 1;
      if (text[next] !== "}" && text[next] !== "]") out += char;
    } else {
      out += char;
    }
  }
  return out;
}

/** Key of the package that encloses `key` (`a/b` is nested in `a`; `@s/a/@s/b` in `@s/a`). */
function enclosing(key: string): string {
  const segments = key.split("/");
  const drop = segments.length >= 2 && segments.at(-2)?.startsWith("@") ? 2 : 1;
  return segments.slice(0, -drop).join("/");
}

/** `name` and `version` out of the `name@spec` identifier at the head of a package entry. */
function parseIdent(ident: string): { name: string; version: string } | undefined {
  const at = ident.indexOf("@", 1);
  if (at <= 0) return undefined;
  const spec = ident.slice(at + 1);
  // An alias reads `alias@npm:real@1.2.3`.
  const version = spec.startsWith("npm:") ? spec.slice(spec.lastIndexOf("@") + 1) : spec;
  return { name: ident.slice(0, at), version };
}

const resolveAll = (
  resolve: (from: string, name: string) => string | undefined,
  ...tables: unknown[]
): string[] =>
  tables
    .flatMap((table) => Object.keys(stringMap(table)))
    .flatMap((name) => resolve("", name) ?? []);

/** Parse the text `bun.lock` (Bun 1.2+). The binary `bun.lockb` is not supported. */
export function parseBunLock(content: string): LockGraph {
  const data: unknown = JSON.parse(stripJsonc(content));
  if (!isRecord(data)) throw new Error("bun.lock is not a JSON object");
  const packages = isRecord(data["packages"]) ? data["packages"] : {};

  const resolve = (from: string, name: string): string | undefined => {
    for (let location = from; ; location = enclosing(location)) {
      const candidate = location === "" ? name : `${location}/${name}`;
      if (Object.hasOwn(packages, candidate)) return candidate;
      if (location === "") return undefined;
    }
  };

  const nodes = new Map<string, LockNode>();
  for (const [key, raw] of Object.entries(packages)) {
    if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
    const ident = parseIdent(raw[0]);
    // Workspace packages are listed as `name@workspace:path`; they are roots, not installs.
    if (!ident || raw[0].includes("@workspace:")) continue;
    const meta = isRecord(raw[2]) ? raw[2] : {};
    const deps = new Set<string>();
    for (const table of [
      meta["dependencies"],
      meta["optionalDependencies"],
      meta["peerDependencies"],
    ]) {
      for (const dep of Object.keys(stringMap(table))) {
        const target = resolve(key, dep);
        if (target !== undefined && target !== key) deps.add(target);
      }
    }
    nodes.set(key, { id: key, name: ident.name, version: ident.version, deps: [...deps] });
  }

  const workspaces = isRecord(data["workspaces"]) ? data["workspaces"] : {};
  const roots: LockRoot[] = Object.entries(workspaces).flatMap(([workspace, raw]) => {
    if (!isRecord(raw)) return [];
    return [
      {
        workspace: workspace === "" ? "." : workspace,
        prod: resolveAll(resolve, raw["dependencies"], raw["optionalDependencies"]),
        dev: resolveAll(resolve, raw["devDependencies"]),
      },
    ];
  });
  return { format: "bun", nodes, roots, recordsInstallScripts: false };
}
