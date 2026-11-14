import semver from "semver";

const NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const NON_REGISTRY = /^(?:[a-z][a-z0-9+.-]*:|\.{0,2}\/|~\/|[\w.-]+\/[\w.-]+$)/i;

export type ParsedSpec =
  | { kind: "registry"; name: string; range?: string }
  | { kind: "other"; reason: string }
  | { kind: "invalid"; reason: string };

/** Split `name`, `name@range`, `@scope/name@range` and `npm:` aliases; recognise what is not a registry package. */
export function parsePackageSpec(input: string): ParsedSpec {
  let spec = input.trim();
  if (!spec) return { kind: "invalid", reason: "empty package name" };

  const alias = /^[^@\s]+@npm:(.+)$/.exec(spec) ?? /^npm:(.+)$/.exec(spec);
  if (alias?.[1]) spec = alias[1];

  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const range = at > 0 ? spec.slice(at + 1) : undefined;

  // `owner/repo` (GitHub shorthand), URLs, git and file specs bypass registry checks.
  if (!name.startsWith("@") && NON_REGISTRY.test(spec)) {
    return { kind: "other", reason: `"${spec.slice(0, 80)}" is not a registry package, so its contents cannot be checked` };
  }
  if (!NAME.test(name) || name.length > 214) {
    return { kind: "invalid", reason: `"${name.slice(0, 80)}" is not a valid npm package name` };
  }
  return { kind: "registry", name, ...(range ? { range } : {}) };
}

const INSTALLERS: Record<string, string[]> = {
  npm: ["install", "i", "add"],
  pnpm: ["add", "install", "i"],
  yarn: ["add"],
  bun: ["add", "install", "i"],
};

/**
 * Package specs a shell command would install. Only the plain forms are understood
 * (`npm install a b@1`, `pnpm add -D x`); anything cleverer (variables, subshells) is not parsed,
 * which is why a hook built on this is a guard rail for agents and not a security boundary.
 */
export function extractInstallSpecs(command: string): string[] {
  const specs: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    // The package manager has to be the command itself, optionally after `sudo` or VAR=value words.
    let tool = 0;
    while (tool < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[tool]!) || words[tool] === "sudo")) {
      tool += 1;
    }
    const manager = words[tool];
    const verbs = manager === undefined ? undefined : INSTALLERS[manager];
    if (!verbs) continue;
    const verb = words[tool + 1];
    if (!verb || !verbs.includes(verb)) continue;
    for (const word of words.slice(tool + 2)) {
      if (word.startsWith("-")) continue;
      const cleaned = word.replaceAll(/^["']|["']$/g, "");
      if (cleaned) specs.push(cleaned);
    }
  }
  return [...new Set(specs)];
}

export function isRange(value: string): boolean {
  return semver.validRange(value) !== null;
}
