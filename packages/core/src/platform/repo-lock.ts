import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

interface RepoLockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
}

interface RepoLock {
  lockPath: string;
  release: () => Promise<void>;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireRepoLock(cwd: string, options: RepoLockOptions = {}): Promise<RepoLock> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const retryDelayMs = options.retryDelayMs ?? 125;
  const lockRoot = join(cwd, ".autoremediator", "locks");
  const lockPath = join(cwd, ".autoremediator", "locks", "remediation.lock");
  const startedAt = Date.now();

  await mkdir(lockRoot, { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath, { recursive: false });
      return {
        lockPath,
        release: async () => {
          await rm(lockPath, { recursive: true, force: true });
        },
      };
    } catch {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for repository lock at ${lockPath}.`);
      }
      await sleep(retryDelayMs);
    }
  }
}

export async function withRepoLock<T>(cwd: string, fn: () => Promise<T>, options?: RepoLockOptions): Promise<T> {
  const lock = await acquireRepoLock(cwd, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
