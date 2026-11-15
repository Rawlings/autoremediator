import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { toRootPackageName } from "../reachability/check-reachability.js";
import type { PackageUsage } from "./scan.js";
import type { DependencySection, UnusedDependency } from "./types.js";

export interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  engines?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: string | Record<string, string>;
  bundledDependencies?: string[];
  bundleDependencies?: string[];
  [key: string]: unknown;
}

export const SECTIONS: readonly DependencySection[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];

/** Manifest fields that describe the package rather than configure a tool. */
const STRUCTURAL_FIELDS = new Set([
  "name",
  "version",
  "description",
  "keywords",
  "homepage",
  "bugs",
  "license",
  "author",
  "contributors",
  "funding",
  "repository",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
  "bundleDependencies",
  "dependenciesMeta",
  "overrides",
  "resolutions",
  "pnpm",
  "scripts",
  "files",
  "publishConfig",
]);

/** The manifest fields a tool reads its configuration from (`eslintConfig`, `jest`, `babel`, ...). */
export function manifestConfigText(manifest: Manifest): string {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest))
    if (!STRUCTURAL_FIELDS.has(key)) config[key] = value;
  return JSON.stringify(config);
}

/** `Manifest.scripts` as one text per script, labelled for evidence. */
export function scriptTexts(manifest: Manifest): [label: string, text: string][] {
  return Object.entries(manifest.scripts ?? {}).map(([name, text]) => [
    `package.json#scripts.${name}`,
    text,
  ]);
}

export function readManifest(file: string): Manifest | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

/** `node_modules/<name>/package.json`, looked up the way Node resolves it: here, then each parent. */
export function readInstalledManifest(
  packageDir: string,
  name: string,
  stopAt: string,
): Manifest | undefined {
  let directory = resolve(packageDir);
  const limit = resolve(stopAt);
  for (;;) {
    const file = join(directory, "node_modules", name, "package.json");
    if (existsSync(file)) return readManifest(file);
    if (directory === limit) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Command names a package installs, from its `bin` field. */
export function binNames(manifest: Manifest, packageName: string): string[] {
  const bin = manifest.bin;
  if (typeof bin === "string") return [packageName.split("/").at(-1) ?? packageName];
  return bin && typeof bin === "object" ? Object.keys(bin) : [];
}

/**
 * Names a token in a config file, CI file or script can stand for. ESLint, Babel, Prettier and
 * Stylelint load `react` as `eslint-plugin-react`, `@babel/env` as `@babel/preset-env`, and so on;
 * `ts-node/register` is the package `ts-node`; tsconfig `types: ["node"]` is `@types/node`.
 */
export function candidatePackages(token: string): string[] {
  const root = toRootPackageName(token);
  const names = new Set<string>([root]);
  if (root.startsWith("@")) {
    const [scope, name] = root.split("/");
    if (scope && name) {
      for (const prefix of [
        "eslint-plugin-",
        "eslint-config-",
        "babel-preset-",
        "babel-plugin-",
        "preset-",
        "plugin-",
        "stylelint-config-",
      ]) {
        names.add(`${scope}/${prefix}${name}`);
      }
      names.add(`@types/${scope.slice(1)}__${name}`);
      // `plugin:@scope/recommended` names the scope's plugin, whatever follows the slash.
      names.add(`${scope}/eslint-plugin`);
      names.add(`${scope}/eslint-config`);
    } else if (scope) {
      for (const suffix of ["eslint-plugin", "eslint-config", "babel-preset", "prettier-config"])
        names.add(`${scope}/${suffix}`);
    }
  } else {
    for (const prefix of [
      "eslint-plugin-",
      "eslint-config-",
      "babel-preset-",
      "babel-plugin-",
      "prettier-plugin-",
      "stylelint-config-",
      "stylelint-plugin-",
    ]) {
      names.add(`${prefix}${root}`);
    }
    names.add(`${root}-loader`);
    names.add(`@types/${root}`);
  }
  return [...names];
}

const PLUGIN_STYLE =
  /(^|\/)(eslint-(plugin|config)-|babel-(plugin|preset)-|prettier-plugin-|stylelint-(config|plugin)-|vite-plugin-|rollup-plugin-|webpack-plugin-|postcss-|remark-|rehype-|unplugin-)|-(loader|plugin|preset|adapter)$|^@[^/]+\/(eslint-(plugin|config)|babel-preset|preset-|plugin-)/;

/** A name found in a script or config token, with the file it came from. */
export interface TokenIndex {
  /** Package names a token can stand for. */
  candidates: Map<string, string>;
  /** Raw tokens, for matching command names. */
  raw: ReadonlyMap<string, string>;
}

export function indexTokens(tokens: ReadonlyMap<string, string>): TokenIndex {
  const candidates = new Map<string, string>();
  for (const [token, where] of tokens) {
    for (const name of candidatePackages(token))
      if (!candidates.has(name)) candidates.set(name, where);
  }
  return { candidates, raw: tokens };
}

/** The package an `@types/*` package describes: `@types/node` is `node`, `@types/s__n` is `@s/n`. */
function typesNeeded(name: string): string | undefined {
  if (!name.startsWith("@types/")) return undefined;
  const target = name.slice("@types/".length);
  return target.includes("__") ? `@${target.replace("__", "/")}` : target;
}

export interface ClassifyContext {
  packageDir: string;
  /** Where `node_modules` lookups stop (the workspace root, or the package itself). */
  stopAt: string;
  manifest: Manifest;
  usage: PackageUsage;
  index: TokenIndex;
  /** Usage found in other workspace packages, for a root package whose dependencies they use. */
  elsewhere?: { usage: PackageUsage; index: TokenIndex; packageName: string }[];
  hasTypeScript: boolean;
  hasTsconfig: boolean;
}

export interface Classified {
  /** Dependencies the source imports directly. */
  used: string[];
  unused: UnusedDependency[];
  dependenciesInstalled: boolean;
}

const BASE_REASON =
  "no import, require, string reference, script, config or workflow names it, and it provides no command";

/**
 * Sort a package's declared dependencies into used (imported), used indirectly (named by a script,
 * a config, a type package, a peer), and unused: certainly when every way it could be used was
 * checked and none applies, probably when something the scan cannot see remains possible.
 */
export function classifyDependencies(context: ClassifyContext): Classified {
  const { manifest, usage, index } = context;

  const declared: { name: string; section: DependencySection; range: string }[] = [];
  for (const section of SECTIONS) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (!declared.some((entry) => entry.name === name)) declared.push({ name, section, range });
    }
  }
  const bundled = new Set([
    ...(manifest.bundledDependencies ?? []),
    ...(manifest.bundleDependencies ?? []),
  ]);

  const installed = new Map(
    declared.map(
      (entry) =>
        [
          entry.name,
          readInstalledManifest(context.packageDir, entry.name, context.stopAt),
        ] as const,
    ),
  );
  const dependenciesInstalled =
    declared.length === 0 || [...installed.values()].some((value) => value !== undefined);

  // A package that another declared dependency lists as a peer is there for that dependency.
  const peerOf = new Map<string, { dependent: string; optional: boolean }>();
  for (const [dependent, installedManifest] of installed) {
    for (const peer of Object.keys(installedManifest?.peerDependencies ?? {})) {
      const optional = installedManifest?.peerDependenciesMeta?.[peer]?.optional === true;
      const known = peerOf.get(peer);
      if (!known || (known.optional && !optional)) peerOf.set(peer, { dependent, optional });
    }
  }

  const used: string[] = [];
  const unused: UnusedDependency[] = [];
  const pending: { entry: (typeof declared)[number]; reasons: string[] }[] = [];
  const typeEntries: { entry: (typeof declared)[number]; target: string }[] = [];

  const indirect = (
    entry: (typeof declared)[number],
    reason: string,
    evidence?: string[],
  ): UnusedDependency => ({
    name: entry.name,
    section: entry.section,
    range: entry.range,
    classification: "used-indirectly",
    reason,
    ...(evidence ? { evidence } : {}),
  });

  for (const entry of declared) {
    const { name } = entry;
    const reference = usage.references.get(name);
    if (reference) {
      used.push(name);
      continue;
    }

    // 1. Type declarations: `@types/node` follows TypeScript use; the rest follow their package (below).
    const typesFor = typesNeeded(name);
    if (typesFor === "node" && (context.hasTypeScript || context.hasTsconfig)) {
      unused.push(
        indirect(
          entry,
          "Node's global and built-in types, which any TypeScript source here relies on",
        ),
      );
      continue;
    }
    if (typesFor && typesFor !== "node") {
      typeEntries.push({ entry, target: typesFor });
      continue;
    }

    // 2. TypeScript with a tsconfig is driven by the compiler, editors and bundlers.
    if (name === "typescript" && context.hasTsconfig) {
      unused.push(
        indirect(
          entry,
          "a tsconfig.json is present, and editors and build tools load TypeScript itself",
        ),
      );
      continue;
    }

    // 3. Named by a script, a config file, a CI workflow or a manifest tool section.
    const configured = index.candidates.get(name);
    if (configured) {
      unused.push(indirect(entry, "named by tool configuration or a script", [configured]));
      continue;
    }

    // 4. One of its commands is run.
    const installedManifest = installed.get(name);
    const commands = installedManifest ? binNames(installedManifest, name) : [];
    const usedCommand = commands.find((command) => index.raw.has(command));
    if (usedCommand) {
      unused.push(
        indirect(entry, `its command "${usedCommand}" is run`, [index.raw.get(usedCommand)!]),
      );
      continue;
    }

    // 5. Another declared dependency lists it as a peer (an optional peer is loaded when present).
    const peerFor = peerOf.get(name);
    if (peerFor) {
      unused.push(
        indirect(
          entry,
          `a${peerFor.optional ? "n optional" : ""} peer dependency of ${peerFor.dependent}${peerFor.optional ? ", which uses it when installed" : ""}`,
        ),
      );
      continue;
    }

    // 6. Declared again as this package's own peer: the development copy.
    if (manifest.peerDependencies?.[name]) {
      unused.push(
        indirect(
          entry,
          "also declared as a peer dependency (the development copy used to build and test against)",
        ),
      );
      continue;
    }

    // 7. Named as a string: a mock, a dynamic specifier, a plugin list in a script file.
    const mention = usage.mentions.get(name);
    if (mention) {
      unused.push(
        indirect(
          entry,
          "named in a string rather than imported (a mock path, plugin list or dynamic specifier)",
          mention,
        ),
      );
      continue;
    }

    // 8. Used by another package of the workspace, for dependencies declared at the root.
    const consumer = context.elsewhere?.find(
      (other) =>
        other.usage.references.has(name) ||
        other.usage.mentions.has(name) ||
        other.index.candidates.has(name) ||
        commands.some((command) => other.index.raw.has(command)),
    );
    if (consumer) {
      unused.push(indirect(entry, `used by the workspace package ${consumer.packageName}`));
      continue;
    }

    if (bundled.has(name)) {
      unused.push(indirect(entry, "listed in bundledDependencies, so it ships with the package"));
      continue;
    }

    // Nothing found. How sure is that?
    const reasons: string[] = [];
    if (entry.section === "optionalDependencies") {
      reasons.push(
        "an optional dependency, usually a platform-specific or conditionally loaded package",
      );
    }
    if (installedManifest === undefined) {
      reasons.push("not installed here, so its commands and peer links could not be read");
    }
    if (commands.length > 0) {
      reasons.push(
        `provides the command${commands.length > 1 ? "s" : ""} ${commands.map((command) => `"${command}"`).join(", ")}, which no script, config or workflow here runs (it may be run by hand or from outside the repository)`,
      );
    }
    if (PLUGIN_STYLE.test(name)) {
      reasons.push(
        "a plugin, preset, loader or config package, which tools load by name from configuration the scan did not find it in",
      );
    }
    if (typesFor === "node") {
      reasons.push("Node's types, but no TypeScript file or tsconfig was found");
    }
    if (usage.dynamicLoadFiles.length > 0) {
      reasons.push(
        `${usage.dynamicLoadFiles.length} file(s) load modules by a name only known at runtime, which could load it`,
      );
    }
    if (usage.unparsedFiles.length > 0) {
      reasons.push(
        `${usage.unparsedFiles.length} file(s) could not be fully read, and might import it`,
      );
    }
    const sourceInWorkspace =
      usage.sourceFiles > 0 ||
      (context.elsewhere ?? []).some((other) => other.usage.sourceFiles > 0);
    if (!sourceInWorkspace) {
      reasons.push("no source files were found, so usage cannot be judged");
    }
    pending.push({ entry, reasons });
  }

  for (const { entry, reasons } of pending) {
    unused.push({
      name: entry.name,
      section: entry.section,
      range: entry.range,
      classification: reasons.length === 0 ? "certainly-unused" : "probably-unused",
      reason: reasons.length === 0 ? BASE_REASON : reasons.join("; "),
    });
  }

  // `@types/x` follows `x`: used if x is, unused if x is, unknown if x is not here at all.
  const classified = new Map(unused.map((entry) => [entry.name, entry.classification] as const));
  for (const { entry, target } of typeEntries) {
    const targetClass = classified.get(target);
    const targetUsed =
      usage.references.has(target) ||
      usage.mentions.has(target) ||
      index.candidates.has(target) ||
      used.includes(target);
    const base = { name: entry.name, section: entry.section, range: entry.range };
    if (targetUsed || targetClass === "used-indirectly") {
      unused.push({
        ...base,
        classification: "used-indirectly",
        reason: `type declarations for ${target}, which this package uses`,
      });
    } else if (targetClass === "certainly-unused") {
      unused.push({
        ...base,
        classification: "certainly-unused",
        reason: `type declarations for ${target}, which is itself unused`,
      });
    } else if (targetClass === "probably-unused") {
      unused.push({
        ...base,
        classification: "probably-unused",
        reason: `type declarations for ${target}, which is itself probably unused`,
      });
    } else {
      unused.push({
        ...base,
        classification: "probably-unused",
        reason: `type declarations for ${target}, which is neither declared nor imported here; global-type packages (a test runner's) apply without an import`,
      });
    }
  }

  unused.sort((left, right) => left.name.localeCompare(right.name));
  return { used, unused, dependenciesInstalled };
}
