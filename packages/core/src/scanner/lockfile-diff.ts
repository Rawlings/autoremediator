import YAML from "yaml";
import semver from "semver";
import type { DeltaDependencyChange } from "../platform/types.js";

/**
 * Extracts a map of package names to their resolved versions from a lockfile content.
 */
export function parseLockfileDependencies(
  filename: string,
  content: string,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  const add = (name: string, ver?: string) => {
    if (!name || !ver) return;
    const cleanVer = semver.clean(ver) || semver.coerce(ver)?.version || ver;
    let set = result.get(name);
    if (!set) {
      set = new Set();
      result.set(name, set);
    }
    set.add(cleanVer);
  };

  if (filename.endsWith("package-lock.json")) {
    try {
      const data = JSON.parse(content);
      if (data.packages && typeof data.packages === "object") {
        for (const [key, pkg] of Object.entries(data.packages)) {
          if (!key || key === "" || typeof pkg !== "object" || !pkg) continue;
          const idx = key.lastIndexOf("node_modules/");
          if (idx !== -1) {
            const rawName = key.slice(idx + "node_modules/".length);
            const ver = (pkg as { version?: string }).version;
            add(rawName, ver);
          }
        }
      }
      if (data.dependencies && typeof data.dependencies === "object") {
        const walkDeps = (deps: Record<string, unknown>) => {
          for (const [name, info] of Object.entries(deps)) {
            if (!info || typeof info !== "object") continue;
            const depObj = info as { version?: string; dependencies?: Record<string, unknown> };
            add(name, depObj.version);
            if (depObj.dependencies && typeof depObj.dependencies === "object") {
              walkDeps(depObj.dependencies);
            }
          }
        };
        walkDeps(data.dependencies as Record<string, unknown>);
      }
    } catch {
      // Ignore JSON parse error
    }
  } else if (filename.endsWith("pnpm-lock.yaml")) {
    try {
      const data = YAML.parse(content) as {
        packages?: Record<string, { name?: string; version?: string }>;
        snapshots?: Record<string, unknown>;
      };
      if (data?.packages && typeof data.packages === "object") {
        for (const [key, val] of Object.entries(data.packages)) {
          let rawKey = key.replace(/^\//, "");
          const parenIdx = rawKey.indexOf("(");
          if (parenIdx !== -1) {
            rawKey = rawKey.slice(0, parenIdx);
          }
          const lastAt = rawKey.lastIndexOf("@");
          if (lastAt > 0) {
            const name = val?.name ?? rawKey.slice(0, lastAt);
            const version = val?.version ?? rawKey.slice(lastAt + 1);
            add(name, version);
          }
        }
      }
      if (data?.snapshots && typeof data.snapshots === "object") {
        for (const key of Object.keys(data.snapshots)) {
          let rawKey = key.replace(/^\//, "");
          const parenIdx = rawKey.indexOf("(");
          if (parenIdx !== -1) {
            rawKey = rawKey.slice(0, parenIdx);
          }
          const lastAt = rawKey.lastIndexOf("@");
          if (lastAt > 0) {
            const name = rawKey.slice(0, lastAt);
            const version = rawKey.slice(lastAt + 1);
            add(name, version);
          }
        }
      }
    } catch {
      // Ignore YAML parse error
    }
  } else if (filename.endsWith("yarn.lock")) {
    const lines = content.split("\n");
    let currentPackages: string[] = [];
    for (const line of lines) {
      if (line.startsWith("#") || line.trim() === "") continue;
      if (!line.startsWith(" ")) {
        currentPackages = [];
        const parts = line.split(",").map((p) => p.trim().replace(/^"/, "").replace(/":?$/, ""));
        for (const part of parts) {
          const lastAt = part.lastIndexOf("@");
          if (lastAt > 0) {
            currentPackages.push(part.slice(0, lastAt));
          }
        }
      } else {
        const match = line.match(/^\s+version\s+"?([^"\s]+)"?/);
        if (match && currentPackages.length > 0) {
          const ver = match[1];
          for (const pkg of currentPackages) {
            add(pkg, ver);
          }
          currentPackages = [];
        }
      }
    }
  }

  return result;
}

/**
 * Computes difference between old and new lockfile content.
 */
export function computeLockfileDiff(
  filename: string,
  oldContent: string | null,
  newContent: string | null,
): DeltaDependencyChange[] {
  const changes: DeltaDependencyChange[] = [];
  const oldDeps = oldContent ? parseLockfileDependencies(filename, oldContent) : new Map<string, Set<string>>();
  const newDeps = newContent ? parseLockfileDependencies(filename, newContent) : new Map<string, Set<string>>();

  const allPkgs = new Set([...oldDeps.keys(), ...newDeps.keys()]);

  for (const pkg of allPkgs) {
    const oldVers = oldDeps.get(pkg) ?? new Set();
    const newVers = newDeps.get(pkg) ?? new Set();

    // Check newly introduced versions
    for (const nVer of newVers) {
      if (!oldVers.has(nVer)) {
        if (oldVers.size === 0) {
          changes.push({
            packageName: pkg,
            changeType: "added",
            newVersion: nVer,
            dependencyType: "transitive",
            manifestPath: filename,
          });
        } else {
          const [firstOld] = oldVers;
          const cleanOld = semver.clean(firstOld) || semver.coerce(firstOld)?.version;
          const cleanNew = semver.clean(nVer) || semver.coerce(nVer)?.version;
          const isUpgrade =
            cleanOld && cleanNew && semver.valid(cleanOld) && semver.valid(cleanNew)
              ? semver.gt(cleanNew, cleanOld)
              : true;

          changes.push({
            packageName: pkg,
            changeType: isUpgrade ? "upgraded" : "downgraded",
            oldVersion: firstOld,
            newVersion: nVer,
            dependencyType: "transitive",
            manifestPath: filename,
          });
        }
      }
    }

    // Check removed versions (only if package no longer exists in new lockfile)
    if (newVers.size === 0 && oldVers.size > 0) {
      for (const oVer of oldVers) {
        changes.push({
          packageName: pkg,
          changeType: "removed",
          oldVersion: oVer,
          dependencyType: "transitive",
          manifestPath: filename,
        });
      }
    }
  }

  return changes;
}
