import type { LockGraph, LockNode, LockRoot, ManifestDeps } from "./types.js";

interface Block {
  descriptors: string[];
  version?: string;
  dependencies: Array<[string, string]>;
  requiresBuild: boolean;
}

const unquote = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
};

/** `name@range` descriptors out of a block header, classic (`a@1, "b@2":`) or berry (`"a@npm:1, b@npm:2":`). */
function descriptorsOf(header: string): string[] {
  const body = header.endsWith(":") ? header.slice(0, -1) : header;
  // Descriptors never contain quotes or commas themselves, so both can be dropped wholesale.
  return body
    .replaceAll('"', "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** The package name of a descriptor: everything before the `@` that starts the range. */
function nameOfDescriptor(descriptor: string): string | undefined {
  const at = descriptor.indexOf("@", 1);
  return at > 0 ? descriptor.slice(0, at) : undefined;
}

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | undefined;
  let section: "dependencies" | "other" | undefined;

  for (const raw of content.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.startsWith("#")) continue;
    if (!raw.startsWith(" ")) {
      current = raw.startsWith("__metadata")
        ? undefined
        : { descriptors: descriptorsOf(raw.trim()), dependencies: [], requiresBuild: false };
      if (current) blocks.push(current);
      section = undefined;
      continue;
    }
    if (!current) continue;

    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent <= 2) {
      section = /^(?:dependencies|optionalDependencies):?$/.test(line) ? "dependencies" : "other";
      const version = /^version:?\s+"?([^"\s]+)"?$/.exec(line);
      if (version?.[1]) current.version = version[1];
      if (/^requiresBuild:\s*true$/.test(line)) current.requiresBuild = true;
      continue;
    }
    if (section === "dependencies") {
      // classic: `name "range"` or `name range`; berry: `name: range` or `"name": "range"`.
      const match = /^("[^"]+"|[^\s:]+):?\s+(.+)$/.exec(line);
      if (match?.[1] && match[2]) current.dependencies.push([unquote(match[1]), unquote(match[2])]);
    }
  }
  return blocks;
}

/** Parse `yarn.lock`, classic (v1) or berry. Roots come from the manifest, which the lockfile does not record. */
export function parseYarnLock(content: string, manifest: ManifestDeps = {}): LockGraph {
  const blocks = parseBlocks(content);
  const byDescriptor = new Map<string, string>();
  const nodes = new Map<string, LockNode>();
  const pending: Array<{ id: string; deps: Array<[string, string]> }> = [];

  for (const block of blocks) {
    const first = block.descriptors[0];
    const name = first === undefined ? undefined : nameOfDescriptor(first);
    // Berry lists the workspaces themselves as entries; they are not installed packages.
    if (
      !name ||
      block.version === undefined ||
      block.descriptors.some((descriptor) => descriptor.includes("@workspace:"))
    ) {
      continue;
    }
    const id = `${name}@${block.version}`;
    for (const descriptor of block.descriptors) byDescriptor.set(descriptor, id);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        name,
        version: block.version,
        deps: [],
        ...(block.requiresBuild ? { installScript: true } : {}),
      });
    }
    pending.push({ id, deps: block.dependencies });
  }

  const resolve = (name: string, range: string): string | undefined =>
    byDescriptor.get(`${name}@${range}`) ?? byDescriptor.get(`${name}@npm:${range}`);

  for (const { id, deps } of pending) {
    const node = nodes.get(id)!;
    const targets = new Set(node.deps);
    for (const [name, range] of deps) {
      const target = resolve(name, range);
      if (target !== undefined) targets.add(target);
    }
    node.deps = [...targets];
  }

  const resolveAll = (table: Record<string, string> | undefined): string[] =>
    Object.entries(table ?? {}).flatMap(([name, range]) => resolve(name, range) ?? []);
  const root: LockRoot = {
    workspace: ".",
    prod: [...resolveAll(manifest.dependencies), ...resolveAll(manifest.optionalDependencies)],
    dev: resolveAll(manifest.devDependencies),
  };
  return { format: "yarn", nodes, roots: [root], recordsInstallScripts: false };
}
