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
    return {
      kind: "other",
      reason: `"${spec.slice(0, 80)}" is not a registry package, so its contents cannot be checked`,
    };
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

/** Flags that take their value as the next word, per package manager (`--flag=value` carries it inline). */
const VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  npm: new Set([
    "--registry",
    "--prefix",
    "--workspace",
    "-w",
    "--tag",
    "--cache",
    "--loglevel",
    "--userconfig",
    "--omit",
    "--include",
    "--otp",
  ]),
  pnpm: new Set([
    "--filter",
    "-F",
    "--dir",
    "-C",
    "--registry",
    "--reporter",
    "--loglevel",
    "--workspace-concurrency",
  ]),
  yarn: new Set([
    "--cwd",
    "--registry",
    "--cache-folder",
    "--modules-folder",
    "--network-timeout",
    "--mutex",
  ]),
  bun: new Set(["--cwd", "-c", "--config", "--registry", "--cache-dir", "--backend"]),
};

/**
 * Package specs a shell command would install. Plain forms are understood, including options
 * before or after the verb (`npm -g install a`, `pnpm -w add -D b`, `yarn workspace app add c`,
 * `npm i --registry https://r d`). Anything cleverer (variables, subshells, scripts) is not parsed,
 * which is why a hook built on this is a guard rail for agents and not a security boundary.
 */
export function extractInstallSpecs(command: string): string[] {
  const specs: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    // The package manager has to be the command itself, optionally after `sudo` or VAR=value words.
    let at = 0;
    while (
      at < words.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!) || words[at] === "sudo")
    ) {
      at += 1;
    }
    const manager = words[at];
    const verbs = manager === undefined ? undefined : INSTALLERS[manager];
    if (!manager || !verbs) continue;
    const valueFlags = VALUE_FLAGS[manager] ?? new Set<string>();

    // Find the verb, stepping over options (and their values) and, for yarn, `workspace <name>`.
    let i = at + 1;
    let verb: string | undefined;
    while (i < words.length) {
      const word = words[i]!;
      if (word.startsWith("-")) {
        i += word.includes("=") || !valueFlags.has(word) ? 1 : 2;
      } else if (manager === "yarn" && word === "workspace") {
        i += 2;
      } else {
        verb = word;
        break;
      }
    }
    if (!verb || !verbs.includes(verb)) continue;

    for (i += 1; i < words.length; i += 1) {
      const word = words[i]!;
      if (word.startsWith("-")) {
        if (!word.includes("=") && valueFlags.has(word)) i += 1;
        continue;
      }
      const cleaned = word.replaceAll(/^["']|["']$/g, "");
      if (cleaned) specs.push(cleaned);
    }
  }
  return [...new Set(specs)];
}

export function isRange(value: string): boolean {
  return semver.validRange(value) !== null;
}
