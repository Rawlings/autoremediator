import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { safeExeca } from "../../shared/exec/safe-exec.js";
import { MEMORY_PATH, TRACK_RECORD_PATH } from "../../shared/state-paths.js";

export interface ProjectSnapshot {
  cwd: string;
  isGit: boolean;
  /** Absolute git work-tree root; porcelain status paths are relative to this, not to cwd. */
  gitRoot?: string;
  gitStatusBefore?: string[];
  fileSnapshots: Map<string, string | null>; // relative path -> content or null (if non-existent)
}

const MANIFEST_PATTERNS = [
  /package\.json$/,
  /^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock)$/,
  /deno\.jsonc?$/,
  /\.patch$/,
  /\.autoremediator\.ya?ml$/,
  /^pnpm-workspace\.ya?ml$/,
  /tsconfig.*\.json$/,
];

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".pnpm-store"]);

// Global registry of active rollback snapshots for dynamic file touch tracking
const activeSnapshots: Set<ProjectSnapshot> = new Set();

export function registerActiveSnapshot(snapshot: ProjectSnapshot): void {
  activeSnapshots.add(snapshot);
}

export function unregisterActiveSnapshot(snapshot: ProjectSnapshot): void {
  activeSnapshots.delete(snapshot);
}

/**
 * Registers an arbitrary file that is about to be modified/created in any active rollback transactions.
 */
export function recordFileTouch(filePath: string): void {
  for (const snapshot of activeSnapshots) {
    const absPath = isAbsolute(filePath) ? filePath : join(snapshot.cwd, filePath);
    if (!absPath.startsWith(snapshot.cwd)) continue;

    const relPath = relative(snapshot.cwd, absPath);
    if (!snapshot.fileSnapshots.has(relPath)) {
      if (existsSync(absPath)) {
        try {
          snapshot.fileSnapshots.set(relPath, readFileSync(absPath, "latin1"));
        } catch {
          try {
            snapshot.fileSnapshots.set(relPath, readFileSync(absPath).toString("base64"));
          } catch {
            snapshot.fileSnapshots.set(relPath, null);
          }
        }
      } else {
        snapshot.fileSnapshots.set(relPath, null);
      }
    }
  }
}

/**
 * Dynamically discovers manifest, lockfile, and patch configuration files across the project tree.
 */
export function discoverProjectFiles(dir: string, maxDepth = 4, currentDepth = 0): string[] {
  const discovered: string[] = [];
  if (currentDepth > maxDepth) return discovered;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return discovered;
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      discovered.push(...discoverProjectFiles(fullPath, maxDepth, currentDepth + 1));
    } else if (stat.isFile()) {
      const matchesPattern = MANIFEST_PATTERNS.some((pattern) => pattern.test(entry));
      if (matchesPattern) {
        discovered.push(fullPath);
      }
    }
  }

  return discovered;
}

async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const res = await safeExeca("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: "pipe",
    });
    return res.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function resolveGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const res = await safeExeca("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe" });
    const root = res.stdout.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a `git status --porcelain` path (relative to the repo root) to an absolute path,
 * returning null unless it lies strictly inside the snapshot's cwd. Rollback must never
 * delete or revert anything outside the project directory it was asked to protect.
 */
function resolveGitStatusPath(snapshot: ProjectSnapshot, filePath: string): string | null {
  const full = resolve(snapshot.gitRoot ?? snapshot.cwd, filePath);
  let realCwd = snapshot.cwd;
  try {
    realCwd = realpathSync(snapshot.cwd);
  } catch {
    // fall back to the spelling we were given
  }
  const rel = relative(realCwd, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  // The autonomy track record is history, not project state: a rollback must not rewind it.
  // Remediation memory is history too.
  const normalized = rel.replaceAll("\\", "/");
  if (normalized === TRACK_RECORD_PATH || normalized === MEMORY_PATH) return null;
  // Everything else the tool keeps under `.autoremediator/` (other runs, recipes, evidence, locks) is
  // its own bookkeeping or committed knowledge, not project state, whether or not it is gitignored.
  if (normalized.startsWith(".autoremediator/")) return null;
  return join(snapshot.cwd, rel);
}

export function parsePorcelainLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length >= 3 && l.slice(0, 2).trim().length > 0);
}

export function parseGitPorcelainLine(
  line: string,
): { statusCode: string; filePath: string } | null {
  if (!line || line.length < 3) return null;
  const statusCode = line.slice(0, 2).trim();
  let filePath = line.slice(3).trim();
  if (filePath.includes(" -> ")) {
    filePath = filePath.split(" -> ").pop()!.trim();
  }
  if (filePath.startsWith('"') && filePath.endsWith('"')) {
    filePath = filePath.slice(1, -1).replaceAll(String.raw`\"`, '"');
  }
  return { statusCode, filePath };
}

async function getGitStatusPorcelain(cwd: string): Promise<string[]> {
  try {
    const res = await safeExeca("git", ["status", "--porcelain=v1", "-uall"], {
      cwd,
      stdio: "pipe",
    });
    return parsePorcelainLines(res.stdout);
  } catch {
    return [];
  }
}

/**
 * Creates an intelligent, Git-aware snapshot of the repository state.
 */
export async function createProjectSnapshot(
  cwd: string,
  explicitFiles?: string[],
): Promise<ProjectSnapshot> {
  const isGit = await isGitRepository(cwd);
  const gitStatusBefore = isGit ? await getGitStatusPorcelain(cwd) : undefined;
  const gitRoot = isGit ? await resolveGitRoot(cwd) : undefined;
  const fileSnapshots = new Map<string, string | null>();

  const targetFiles = explicitFiles
    ? explicitFiles.map((f) => (f.startsWith(cwd) ? f : join(cwd, f)))
    : discoverProjectFiles(cwd);

  for (const fullPath of targetFiles) {
    const relPath = relative(cwd, fullPath);
    if (existsSync(fullPath)) {
      try {
        fileSnapshots.set(relPath, readFileSync(fullPath, "latin1"));
      } catch {
        try {
          fileSnapshots.set(relPath, readFileSync(fullPath).toString("base64"));
        } catch {
          // Skip unreadable files
        }
      }
    } else {
      fileSnapshots.set(relPath, null);
    }
  }

  const snapshot: ProjectSnapshot = {
    cwd,
    isGit,
    gitRoot,
    gitStatusBefore,
    fileSnapshots,
  };

  return snapshot;
}

/**
 * Restores project state from snapshot using Git transaction restore or in-memory fallback.
 */
export async function restoreProjectSnapshot(snapshot: ProjectSnapshot): Promise<void> {
  // 1. In-memory exact file restoration for all tracked and dynamically touched files
  for (const [relPath, previousContent] of snapshot.fileSnapshots.entries()) {
    const fullPath = join(snapshot.cwd, relPath);
    // A snapshot can come from a file the project carries; never write or delete outside it.
    const escape = relative(snapshot.cwd, fullPath);
    if (escape.startsWith("..") || isAbsolute(escape)) {
      throw new Error(`Refusing to restore "${relPath}": it is outside the project.`);
    }
    if (previousContent === null) {
      if (existsSync(fullPath)) {
        try {
          rmSync(fullPath, { force: true, recursive: true });
        } catch {
          // Ignore removal error
        }
      }
    } else {
      try {
        writeFileSync(fullPath, previousContent, "latin1");
      } catch {
        // Ignore write error
      }
    }
  }

  // 2. Discover any newly created files matching manifest/patch patterns that were not in snapshot
  const currentFiles = discoverProjectFiles(snapshot.cwd);
  for (const fullPath of currentFiles) {
    const relPath = relative(snapshot.cwd, fullPath);
    if (!snapshot.fileSnapshots.has(relPath)) {
      try {
        rmSync(fullPath, { force: true, recursive: true });
      } catch {
        // Ignore removal error
      }
    }
  }

  // 3. If inside Git repo, clean any newly introduced untracked artifacts not in before-status
  if (snapshot.isGit) {
    try {
      const currentStatus = await getGitStatusPorcelain(snapshot.cwd);
      const beforeSet = new Set(snapshot.gitStatusBefore ?? []);

      for (const line of currentStatus) {
        if (beforeSet.has(line)) continue;
        const parsed = parseGitPorcelainLine(line);
        if (!parsed) continue;
        const { statusCode, filePath } = parsed;
        const fullPath = resolveGitStatusPath(snapshot, filePath);
        if (!fullPath) continue;

        if (statusCode === "??" && existsSync(fullPath)) {
          // Untracked newly generated file
          try {
            rmSync(fullPath, { force: true, recursive: true });
          } catch {
            // Ignore
          }
        } else if (
          statusCode === "M" ||
          statusCode === "MM" ||
          statusCode === "D" ||
          statusCode.includes("M") ||
          statusCode.includes("D") ||
          statusCode.includes("T")
        ) {
          // Revert tracked modified or deleted file
          try {
            await safeExeca("git", ["checkout", "--", fullPath], {
              cwd: snapshot.cwd,
              stdio: "pipe",
            });
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Non-fatal Git clean error
    }
  }
}

/**
 * Synchronously restores project state from snapshot.
 */
export function restoreProjectSnapshotSync(snapshot: ProjectSnapshot): void {
  // 1. In-memory exact file restoration for all tracked and dynamically touched files
  for (const [relPath, previousContent] of snapshot.fileSnapshots.entries()) {
    const fullPath = join(snapshot.cwd, relPath);
    if (previousContent === null) {
      if (existsSync(fullPath)) {
        try {
          rmSync(fullPath, { force: true, recursive: true });
        } catch {
          // Ignore removal error
        }
      }
    } else {
      try {
        writeFileSync(fullPath, previousContent, "latin1");
      } catch {
        // Ignore write error
      }
    }
  }

  // 2. Discover any newly created files matching manifest/patch patterns that were not in snapshot
  const currentFiles = discoverProjectFiles(snapshot.cwd);
  for (const fullPath of currentFiles) {
    const relPath = relative(snapshot.cwd, fullPath);
    if (!snapshot.fileSnapshots.has(relPath)) {
      try {
        rmSync(fullPath, { force: true, recursive: true });
      } catch {
        // Ignore removal error
      }
    }
  }

  // 3. If inside a Git repository, clean untracked artifacts and revert tracked modified files
  if (snapshot.isGit) {
    try {
      const stdout = execSync("git status --porcelain=v1 -uall", {
        cwd: snapshot.cwd,
        stdio: ["pipe", "pipe", "ignore"],
        encoding: "utf8",
      });
      const currentStatus = parsePorcelainLines(stdout);
      const beforeSet = new Set(snapshot.gitStatusBefore ?? []);

      for (const line of currentStatus) {
        if (beforeSet.has(line)) continue;
        const parsed = parseGitPorcelainLine(line);
        if (!parsed) continue;
        const { statusCode, filePath } = parsed;
        const fullPath = resolveGitStatusPath(snapshot, filePath);
        if (!fullPath) continue;

        if (statusCode === "??" && existsSync(fullPath)) {
          try {
            rmSync(fullPath, { force: true, recursive: true });
          } catch {
            // Ignore
          }
        } else if (
          statusCode === "M" ||
          statusCode === "MM" ||
          statusCode === "D" ||
          statusCode.includes("M") ||
          statusCode.includes("D") ||
          statusCode.includes("T")
        ) {
          try {
            execFileSync("git", ["checkout", "--", fullPath], {
              cwd: snapshot.cwd,
              stdio: "ignore",
            });
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Non-fatal Git error
    }
  }
}

/**
 * Executes an action inside an atomic rollback transaction envelope.
 */
export async function withAtomicRollback<T>(
  cwd: string,
  action: () => Promise<T>,
  options: {
    filesToTrack?: string[];
    shouldRollback?: (result: T) => boolean;
  } = {},
): Promise<T> {
  const snapshot = await createProjectSnapshot(cwd, options.filesToTrack);
  activeSnapshots.add(snapshot);

  try {
    const result = await action();
    if (options.shouldRollback?.(result)) {
      await restoreProjectSnapshot(snapshot);
    }
    return result;
  } catch (error) {
    await restoreProjectSnapshot(snapshot);
    throw error;
  } finally {
    activeSnapshots.delete(snapshot);
  }
}
