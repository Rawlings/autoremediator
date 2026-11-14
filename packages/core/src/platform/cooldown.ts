/**
 * Release cooldown ("minimum release age") that the project's own package manager enforces.
 *
 * Installing a version younger than the cooldown fails, so choosing one would only end in a failed
 * install. This reads the setting from the project's configuration and folds it into the
 * supply-chain policy as a minimum publish age.
 *
 * Sources and units:
 *   npm   `min-release-age` in `.npmrc` / `npm_config_min_release_age`   (days)
 *   pnpm  `minimumReleaseAge` in `pnpm-workspace.yaml`, or `minimum-release-age` in `.npmrc` (minutes);
 *         pnpm 11+ defaults to 1440 minutes when unset (version from the `packageManager` field)
 *   yarn  `npmMinimalAgeGate` in `.yarnrc.yml`                           (minutes)
 *   bun   `minimumReleaseAge` under `[install]` in `bunfig.toml`         (seconds)
 * Values that are not plain numbers are ignored rather than guessed at.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parse as parseYaml } from "yaml";

import { readNpmrcChain } from "./registry-config.js";
import type { PackageManager, SupplyChainPolicy } from "./types.js";

export interface Cooldown {
  hours: number;
  /** Package names or `*` globs the package manager exempts from the cooldown. */
  exclude: string[];
  /** Human-readable origin of the setting, e.g. "pnpm minimumReleaseAge". */
  source: string;
}

const PNPM_DEFAULT_MINUTES = 1440;
const MAX_PARENT_LOOKUPS = 8;

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Nearest `file` in `cwd` or an ancestor (monorepo roots hold the shared config). */
function findUp(file: string, cwd: string): string | undefined {
  let dir = cwd;
  for (let depth = 0; depth <= MAX_PARENT_LOOKUPS; depth++) {
    const candidate = join(dir, file);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** A non-negative finite number from a config value; anything else is "not set". */
function toNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readYamlFile(path: string | undefined): Record<string, unknown> {
  const text = path ? readText(path) : undefined;
  if (!text) return {};
  try {
    const parsed: unknown = parseYaml(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function pnpmMajor(cwd: string): number | undefined {
  const manifest = findUp("package.json", cwd);
  const text = manifest ? readText(manifest) : undefined;
  if (!text) return undefined;
  try {
    const field = (JSON.parse(text) as { packageManager?: string }).packageManager ?? "";
    const match = /^pnpm@(\d+)\./.exec(field);
    return match?.[1] ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

const toCooldown = (
  hours: number | undefined,
  exclude: string[],
  source: string,
): Cooldown | undefined => (hours !== undefined && hours > 0 ? { hours, exclude, source } : undefined);

type CooldownReader = (cwd: string, env: NodeJS.ProcessEnv) => Cooldown | undefined;

const readers: Record<PackageManager, CooldownReader> = {
  npm(cwd, env) {
    const npmrc = readNpmrcChain(cwd, env);
    const days = toNumber(env["npm_config_min_release_age"] ?? npmrc.get("min-release-age"));
    return toCooldown(days === undefined ? undefined : days * 24, [], "npm min-release-age");
  },
  pnpm(cwd, env) {
    const workspace = readYamlFile(findUp("pnpm-workspace.yaml", cwd));
    const npmrc = readNpmrcChain(cwd, env);
    const minutes =
      toNumber(workspace["minimumReleaseAge"]) ?? toNumber(npmrc.get("minimum-release-age"));
    const effective = minutes ?? ((pnpmMajor(cwd) ?? 0) >= 11 ? PNPM_DEFAULT_MINUTES : undefined);
    return toCooldown(
      effective === undefined ? undefined : effective / 60,
      toStringList(workspace["minimumReleaseAgeExclude"]),
      minutes === undefined ? "pnpm 11 default minimumReleaseAge" : "pnpm minimumReleaseAge",
    );
  },
  yarn(cwd) {
    const minutes = toNumber(readYamlFile(findUp(".yarnrc.yml", cwd))["npmMinimalAgeGate"]);
    return toCooldown(
      minutes === undefined ? undefined : minutes / 60,
      [],
      "yarn npmMinimalAgeGate",
    );
  },
  bun(cwd) {
    const file = findUp("bunfig.toml", cwd);
    const content = file ? readText(file) : undefined;
    if (!content) return undefined;
    const seconds = toNumber(/^\s*minimumReleaseAge\s*=\s*(\d+)\s*$/m.exec(content)?.[1]);
    const excludes = /^\s*minimumReleaseAgeExcludes\s*=\s*\[([^\]]*)]/m.exec(content)?.[1];
    const exclude = [...(excludes?.matchAll(/["']([^"']+)["']/g) ?? [])].map((m) => m[1] ?? "");
    return toCooldown(
      seconds === undefined ? undefined : seconds / 3600,
      exclude.filter(Boolean),
      "bun minimumReleaseAge",
    );
  },
  // Deno has no release-age setting.
  deno: () => undefined,
};

export function readCooldown(
  cwd: string,
  packageManager: PackageManager,
  env: NodeJS.ProcessEnv = process.env,
): Cooldown | undefined {
  return readers[packageManager](cwd, env);
}

function matchesExclude(packageName: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const source = pattern.replaceAll(/[$()+.?[\\\]^{|}]/g, String.raw`\$&`).replaceAll("*", ".*");
    return new RegExp(`^${source}$`).test(packageName);
  });
}

/**
 * The supply-chain policy to enforce for one package: the stricter of the policy file's minimum
 * age and the package manager's cooldown (unless the package manager exempts this package).
 */
export function withCooldown(
  policy: SupplyChainPolicy | undefined,
  cooldown: Cooldown | undefined,
  packageName: string,
): SupplyChainPolicy | undefined {
  if (!cooldown || matchesExclude(packageName, cooldown.exclude)) return policy;
  const current = policy?.minPublishAgeHours ?? 0;
  if (current >= cooldown.hours) return policy;
  return { ...policy, minPublishAgeHours: cooldown.hours, minPublishAgeSource: cooldown.source };
}
