/**
 * Turn a task's committed project into a working, git-tracked, installed project: the state a user
 * would have before running autoremediator. Everything is generated per run (the registry's port,
 * the lockfile that records it, the baseline commit), so nothing machine-specific is committed.
 */
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import semver from "semver";

import { mustRun, run } from "./exec.ts";
import type { LoadedTask } from "./task.ts";

export interface Project {
  dir: string;
  /** The baseline commit: the project as installed, before anything touches it. */
  baseline: string;
  /** Every installed copy of the vulnerable package at baseline. */
  vulnerableVersions: string[];
}

/** Every installed `name -> versions`, walking nested node_modules. */
export function installedVersions(projectDir: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const visit = (nodeModules: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(nodeModules);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const dirs = entry.startsWith("@")
        ? readdirSync(join(nodeModules, entry)).map((child) => join(nodeModules, entry, child))
        : [join(nodeModules, entry)];
      for (const dir of dirs) {
        try {
          if (!statSync(dir).isDirectory()) continue;
          const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
            name?: string;
            version?: string;
          };
          if (manifest.name && manifest.version) {
            found.set(manifest.name, [...(found.get(manifest.name) ?? []), manifest.version]);
          }
        } catch {
          continue;
        }
        visit(join(dir, "node_modules"));
      }
    }
  };
  visit(join(projectDir, "node_modules"));
  return found;
}

/** Installed versions of `packageName` that fall inside `range`. */
export function vulnerableCopies(projectDir: string, packageName: string, range: string): string[] {
  return (installedVersions(projectDir).get(packageName) ?? []).filter((version) =>
    semver.satisfies(version, range, { includePrerelease: true }),
  );
}

/**
 * The project's `.npmrc`. Install scripts are off unless the task is a trap that needs them on to
 * prove the tool refuses to run them (its canary is a harmless file written by a fixture we wrote).
 */
export const NPMRC = (registryUrl: string, options: { ignoreScripts?: boolean } = {}): string =>
  [
    `registry=${registryUrl}/`,
    "audit=false",
    "fund=false",
    "update-notifier=false",
    ...(options.ignoreScripts === false ? [] : ["ignore-scripts=true"]),
    "",
  ].join("\n");

export async function materialize(
  task: LoadedTask,
  workDir: string,
  registryUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Project> {
  const dir = join(workDir, "project");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  cpSync(task.projectDir, dir, { recursive: true });
  writeFileSync(
    join(dir, ".npmrc"),
    NPMRC(registryUrl, { ignoreScripts: task.expect.canary === undefined }),
  );

  await mustRun("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir, env });
  const before = task.baselineBefore ? [`--before=${task.baselineBefore}`] : [];
  const install = await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...before],
    {
      cwd: dir,
      env,
    },
  );
  if (install.code !== 0)
    throw new Error(`Baseline npm install failed for ${task.id}:\n${install.stderr}`);
  await mustRun("git", ["add", "--all"], { cwd: dir, env });
  await mustRun("git", ["commit", "--quiet", "-m", "baseline"], { cwd: dir, env });
  const baseline = (await mustRun("git", ["rev-parse", "HEAD"], { cwd: dir, env })).stdout.trim();

  const vulnerableVersions = vulnerableCopies(
    dir,
    task.vulnerable.packageName,
    task.vulnerable.vulnerableRange,
  );
  return { dir, baseline, vulnerableVersions };
}
