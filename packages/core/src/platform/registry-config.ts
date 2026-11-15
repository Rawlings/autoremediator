/**
 * npm registry configuration resolved from `.npmrc` files and `npm_config_*` environment variables.
 *
 * Supports the subset of npm's config that decides where a package is fetched from and with
 * which credentials: `registry`, `@scope:registry`, and per-registry `_authToken` / `_auth`
 * entries keyed by "nerf-dart" prefixes (`//host/path/:_authToken=...`). Sources, lowest to highest
 * precedence: user `.npmrc` (`NPM_CONFIG_USERCONFIG` or `~/.npmrc`), project `.npmrc` in `cwd`,
 * `npm_config_registry`. Credentials are only attached to requests whose URL matches the
 * registry they were configured for, and never over plain http except to localhost.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { assertValidPackageName } from "./package-name.js";

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

export interface RegistryConfig {
  /** Registry base URL (no trailing slash) that serves `packageName`. */
  registryUrlFor(packageName: string): string;
  /** Request headers (currently just Authorization) that are safe to send to `url`. */
  headersFor(url: string): Record<string, string>;
}

export type NpmrcValues = Map<string, string>;

function expandEnv(value: string, env: NodeJS.ProcessEnv): string | undefined {
  let missing = false;
  const expanded = value.replaceAll(/\$\{([^}]+)}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) missing = true;
    return resolved ?? "";
  });
  return missing ? undefined : expanded;
}

/**
 * Hosts whose registry credentials a project `.npmrc` may fill from any environment variable
 * (`//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}` is the normal way to use them).
 */
const KNOWN_REGISTRY_HOSTS = new Set(["registry.npmjs.org", "npm.pkg.github.com", "registry.yarnpkg.com"]);
const NPM_SPECIFIC_ENV = /^(?:NPM|NODE_AUTH|YARN|PNPM|BUN)|NPM_(?:TOKEN|AUTH)|REGISTRY/i;

/**
 * Whether a project-level `.npmrc` may put `${name}` into the credential `key`. A repository controls
 * that file, so a pull request could name its own registry and a credential that expands to an
 * ambient secret (`GITHUB_TOKEN`) to have it sent there. Variables made for npm, and the public
 * registry hosts, are fine; anything else is dropped.
 */
export function projectEnvCredentialAllowed(key: string, name: string): boolean {
  const credential = /^\/\/([^/]+)\/.*:(?:_authToken|_auth|_password|username)$/.exec(key);
  if (!credential) return true; // not a credential key: nothing secret is being attached
  if (NPM_SPECIFIC_ENV.test(name)) return true;
  return KNOWN_REGISTRY_HOSTS.has(credential[1] ?? "");
}

export function parseNpmrc(
  content: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { allowEnv?: (key: string, name: string) => boolean } = {},
): NpmrcValues {
  const values: NpmrcValues = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // An entry referencing an unset ${VAR} (or one this file may not read) is dropped, not half-expanded.
    const referenced = [...value.matchAll(/\$\{([^}]+)}/g)].map((match) => match[1] ?? "");
    if (options.allowEnv && referenced.some((name) => !options.allowEnv?.(key, name))) continue;
    const expanded = expandEnv(value, env);
    if (expanded !== undefined) values.set(key, expanded);
  }
  return values;
}

function readNpmrc(path: string, env: NodeJS.ProcessEnv, projectLevel = false): NpmrcValues {
  try {
    return parseNpmrc(
      readFileSync(path, "utf8"),
      env,
      projectLevel ? { allowEnv: projectEnvCredentialAllowed } : {},
    );
  } catch {
    return new Map();
  }
}

const trimTrailingSlashes = (url: string): string => url.replace(/\/+$/, "");

/** `https://host:8080/a/b/` -> `//host:8080/a/b/` (npm's "nerf dart" credential key). */
function toNerfDart(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
    return `//${parsed.host}${path}`;
  } catch {
    return undefined;
  }
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function createRegistryConfig(
  npmrc: NpmrcValues,
  env: NodeJS.ProcessEnv = process.env,
): RegistryConfig {
  const defaultRegistry = trimTrailingSlashes(
    env["npm_config_registry"] ?? env["NPM_CONFIG_REGISTRY"] ?? npmrc.get("registry") ?? DEFAULT_NPM_REGISTRY,
  );

  const scopeRegistries = new Map<string, string>();
  const credentials = new Map<string, string>(); // nerf-dart -> Authorization header value
  for (const [key, value] of npmrc) {
    const scoped = /^(@[^:]+):registry$/.exec(key);
    if (scoped?.[1]) {
      scopeRegistries.set(scoped[1], trimTrailingSlashes(value));
      continue;
    }
    const credential = /^(\/\/.+\/):(_authToken|_auth)$/.exec(key);
    if (!credential?.[1] || !credential[2]) continue;
    credentials.set(
      credential[1],
      credential[2] === "_authToken" ? `Bearer ${value}` : `Basic ${value}`,
    );
  }

  return {
    registryUrlFor(packageName) {
      if (packageName.startsWith("@")) {
        const scope = packageName.slice(0, packageName.indexOf("/"));
        const scoped = scopeRegistries.get(scope);
        if (scoped) return scoped;
      }
      return defaultRegistry;
    },
    headersFor(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return {};
      }
      if (parsed.protocol !== "https:" && !isLocalhost(parsed.hostname)) return {};

      // Longest matching configured prefix wins, as in npm.
      const target = toNerfDart(url);
      if (!target) return {};
      let best: string | undefined;
      for (const prefix of credentials.keys()) {
        if (target.startsWith(prefix) && (!best || prefix.length > best.length)) best = prefix;
      }
      const authorization = best ? credentials.get(best) : undefined;
      const headers: Record<string, string> = {};
      if (authorization) headers["Authorization"] = authorization;
      return headers;
    },
  };
}

/** User `.npmrc` overlaid by the project `.npmrc` in `cwd`; later sources win. */
export function readNpmrcChain(cwd?: string, env: NodeJS.ProcessEnv = process.env): NpmrcValues {
  const userConfigPath = env["NPM_CONFIG_USERCONFIG"] ?? join(homedir(), ".npmrc");
  const merged: NpmrcValues = new Map(readNpmrc(userConfigPath, env));
  if (cwd) {
    for (const [key, value] of readNpmrc(join(cwd, ".npmrc"), env, true)) merged.set(key, value);
  }
  return merged;
}

export function loadRegistryConfig(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): RegistryConfig {
  return createRegistryConfig(readNpmrcChain(cwd, env), env);
}

/** Public registry, no credentials: the behaviour when no project configuration is supplied. */
export const defaultRegistryConfig: RegistryConfig = createRegistryConfig(new Map(), {});

/** URL of a package's packument (`/<name>`; scoped names keep the `@` and encode the `/`). */
export function packumentUrl(config: RegistryConfig, packageName: string): string {
  // The name becomes a path segment of an authenticated request: only a real package name may.
  assertValidPackageName(packageName);
  return `${config.registryUrlFor(packageName)}/${packageName.replaceAll("/", "%2F")}`;
}
