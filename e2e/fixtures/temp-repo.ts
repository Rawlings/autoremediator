import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

export interface TempRepoOptions {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: Record<string, string>;
  initGit?: boolean;
}

export function createTempDir(prefix = "autoremediator-e2e-"): string {
  const dir = join(tmpdir(), `${prefix}${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup error in test environments
  }
}

export async function createTempRepo(options: TempRepoOptions = {}): Promise<string> {
  const dir = createTempDir();
  const pkgJson = {
    name: options.name ?? "fixture-app",
    version: options.version ?? "1.0.0",
    private: true,
    type: "module",
    dependencies: options.dependencies ?? {},
    devDependencies: options.devDependencies ?? {},
  };

  writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson, null, 2), "utf8");

  if (options.files) {
    for (const [relPath, content] of Object.entries(options.files)) {
      const fullPath = join(dir, relPath);
      const lastSlash = relPath.lastIndexOf("/");
      if (lastSlash > 0) {
        const parentDir = join(dir, relPath.slice(0, lastSlash));
        mkdirSync(parentDir, { recursive: true });
      }
      writeFileSync(fullPath, content, "utf8");
    }
  }

  if (options.initGit) {
    execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "E2E Tester"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "e2e@autoremediator.local"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "pipe" });
  }

  return dir;
}

export function writeRepoFile(dir: string, relPath: string, content: string): void {
  const fullPath = join(dir, relPath);
  const lastSlash = relPath.lastIndexOf("/");
  if (lastSlash > 0) {
    const parentDir = join(dir, relPath.slice(0, lastSlash));
    mkdirSync(parentDir, { recursive: true });
  }
  writeFileSync(fullPath, content, "utf8");
}

export function readRepoFile(dir: string, relPath: string): string {
  return readFileSync(join(dir, relPath), "utf8");
}
