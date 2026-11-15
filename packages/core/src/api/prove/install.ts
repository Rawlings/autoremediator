/**
 * Getting two published versions of a package onto disk, each in a directory of its own.
 *
 * The package under test is downloaded by us from the configured registry and checked against the
 * digest the registry advertises before anything touches the disk; a tarball without a digest, or
 * with one that does not match, is refused. It is then installed from that exact file. Its own
 * dependencies, if it has any, are resolved by npm from the same registry with lifecycle scripts
 * disabled; npm checks those against the registry's metadata, we do not check them again.
 */
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import semver from "semver";

import {
  downloadTarball,
  fetchPackageVersions,
  getTarballInfo,
  verifyTarballIntegrity,
} from "../../intelligence/sources/registry.js";
import { type RegistryConfig, loadRegistryConfig } from "../../platform/registry-config.js";
import { safeExeca } from "../../platform/safe-exec.js";
import { readPackageTarball } from "../../remediation/impact/tarball.js";
import type { FetchedPackage } from "./types.js";

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

export function assertPackageName(name: string): void {
  if (!PACKAGE_NAME.test(name)) throw new Error(`Invalid package name: ${name}`);
}

export async function listPublishedVersions(name: string, cwd: string): Promise<string[]> {
  assertPackageName(name);
  return fetchPackageVersions(name, loadRegistryConfig(cwd));
}

/** Download one version and refuse it unless it matches the registry's digest. */
export async function fetchVerifiedPackage(
  name: string,
  version: string,
  cwd: string,
): Promise<FetchedPackage> {
  assertPackageName(name);
  if (!semver.valid(version)) throw new Error(`Not an exact version: ${version}`);
  const registry = loadRegistryConfig(cwd);
  const info = await getTarballInfo(name, version, registry);
  if (!info) throw new Error(`${name}@${version} was not found on the registry`);
  const bytes = await downloadTarball(info, registry);
  const check = verifyTarballIntegrity(bytes, info);
  if (!check.ok) {
    throw new Error(
      `Refusing ${name}@${version}: the tarball failed verification (${check.reason})`,
    );
  }
  if (!check.verified || !info.integrity) {
    throw new Error(
      `Refusing ${name}@${version}: the registry advertises no integrity digest, so the download cannot be verified.`,
    );
  }
  const { files, manifest } = readPackageTarball(bytes);
  return {
    name,
    version,
    bytes,
    source: { name, version, files, manifest, integrityVerified: true },
    integrity: info.integrity,
    tarballUrl: info.url,
  };
}

function registryUrl(registry: RegistryConfig, name: string): string {
  return registry.registryUrlFor(name);
}

/**
 * Lay the package out as `<dir>/node_modules/<name>` from its verified tarball. `dir` must exist
 * and be empty. Nothing from the user's project or home directory is read: npm runs with an
 * environment of its own and no configuration file but the registry URL.
 */
export async function installFetchedPackage(
  dir: string,
  fetched: FetchedPackage,
  cwd: string,
): Promise<void> {
  const tarball = join(dir, "package.tgz");
  writeFileSync(tarball, fetched.bytes);
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "proof-sandbox", version: "0.0.0", private: true })}\n`,
    "utf8",
  );
  const home = join(dir, ".npm-home");
  mkdirSync(home, { recursive: true });

  assertRegistryOnlyDependencies(fetched.source.manifest, `${fetched.name}@${fetched.version}`);
  const dependencies = fetched.source.manifest["dependencies"];
  const hasDependencies =
    typeof dependencies === "object" &&
    dependencies !== null &&
    Object.keys(dependencies).length > 0;
  const registry = loadRegistryConfig(cwd);

  await safeExeca(
    "npm",
    [
      "install",
      tarball,
      "--ignore-scripts",
      "--omit=dev",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-update-notifier",
      "--loglevel=error",
      ...(hasDependencies ? [] : ["--offline"]),
    ],
    {
      cwd: dir,
      timeoutMs: 180_000,
      stdio: "pipe",
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        npm_config_cache: join(home, "cache"),
        npm_config_userconfig: join(home, ".npmrc"),
        npm_config_globalconfig: join(home, ".npmrc-global"),
        npm_config_registry: registryUrl(registry, fetched.name.replace(/^@[^/]+\//, "")),
      },
    },
  );
  assertNoEscapingLinks(dir);
}

/** What a dependency spec may be: a registry range or tag, never a path, URL, git or workspace reference. */
const NON_REGISTRY_SPEC =
  /^(?:file|link|portal|workspace|git|git\+[a-z]+|https?|ssh|github|gitlab|bitbucket|gist):|^[./~\\]|^[^@:\s]+\/[^@:\s]+$/i;

/**
 * The package is attacker-chosen, so its manifest is too. A `file:` or `link:` dependency makes npm
 * create a symlink to a path of the attacker's choosing, and the sandbox's read permission follows
 * symlinks. Registry specs only.
 */
export function assertRegistryOnlyDependencies(
  manifest: Record<string, unknown>,
  label: string,
): void {
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const entries = manifest[field];
    if (typeof entries !== "object" || entries === null) continue;
    for (const [name, spec] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof spec !== "string" || NON_REGISTRY_SPEC.test(spec.trim())) {
        throw new Error(
          `${label} declares ${field}.${name} as "${String(spec).slice(0, 60)}", which is not a registry version; refusing to install it for a proof run.`,
        );
      }
    }
  }
}

/**
 * After the install, no symlink may leave the directory (only `node_modules/.bin` links that stay
 * inside are normal). The sandbox may read everything under `dir`, and a link out of it would let a
 * script read anything the user can. This also catches links created by transitive dependencies.
 */
export function assertNoEscapingLinks(dir: string): void {
  const root = realpathSync(dir);
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const inBin =
          relative(root, current).split(sep).slice(-2).join("/") === "node_modules/.bin";
        let target: string | undefined;
        try {
          target = realpathSync(full);
        } catch {
          target = undefined;
        }
        const inside = target !== undefined && (target === root || target.startsWith(root + sep));
        if (!inBin || !inside) {
          throw new Error(
            `The installed package tree contains a symbolic link (${relative(root, full)}); refusing to run a proof inside it.`,
          );
        }
      } else if (entry.isDirectory()) {
        visit(full);
      }
    }
  };
  visit(root);
}
