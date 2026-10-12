// platform-safe types only — no imports from other packages/core/src/ modules

export interface JobHandle {
  jobId: string;
  status: "pending" | "running" | "done" | "failed";
  submittedAt: string;
}

export interface AsyncRemediationJob extends JobHandle {
  result?: unknown;
  error?: string;
  completedAt?: string;
}

export interface BoundedJobRegistryOptions {
  /** Maximum number of jobs retained in memory. Defaults to 1000. */
  maxCapacity?: number;
  /** Time-to-live in milliseconds before a job is eligible for TTL eviction. Defaults to 24 hours (86,400,000 ms). */
  ttlMs?: number;
}

export interface JobRegistryStats {
  size: number;
  maxCapacity: number;
  ttlMs: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
}

/**
 * Bounded in-memory job registry with TTL eviction and capacity capping.
 * Extends Map<string, AsyncRemediationJob> to maintain full backward compatibility
 * with all existing map operations (get, set, has, delete, clear, iterations).
 */
export class BoundedJobRegistry extends Map<string, AsyncRemediationJob> {
  private maxCapacity: number;
  private ttlMs: number;

  constructor(options: BoundedJobRegistryOptions = {}) {
    super();
    this.maxCapacity = options.maxCapacity ?? 1000;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  }

  public getMaxCapacity(): number {
    return this.maxCapacity;
  }

  public setMaxCapacity(capacity: number): void {
    if (capacity <= 0) {
      throw new Error(`maxCapacity must be greater than 0, received ${capacity}`);
    }
    this.maxCapacity = capacity;
    this.enforceCapacity();
  }

  public getTtl(): number {
    return this.ttlMs;
  }

  public setTtl(ttlMs: number): void {
    if (ttlMs <= 0) {
      throw new Error(`ttlMs must be greater than 0, received ${ttlMs}`);
    }
    this.ttlMs = ttlMs;
  }

  public isExpired(job: AsyncRemediationJob, now = Date.now()): boolean {
    const timestampStr = job.completedAt ?? job.submittedAt;
    const timeMs = new Date(timestampStr).getTime();
    if (isNaN(timeMs)) return false;
    return now - timeMs > this.ttlMs;
  }

  public evictExpired(now = Date.now()): number {
    let count = 0;
    for (const [id, job] of super.entries()) {
      if (this.isExpired(job, now)) {
        super.delete(id);
        count++;
      }
    }
    return count;
  }

  public prune(now = Date.now()): number {
    return this.evictExpired(now);
  }

  override get(jobId: string): AsyncRemediationJob | undefined {
    const job = super.get(jobId);
    if (!job) return undefined;
    if (this.isExpired(job)) {
      super.delete(jobId);
      return undefined;
    }
    return job;
  }

  override has(jobId: string): boolean {
    const job = super.get(jobId);
    if (!job) return false;
    if (this.isExpired(job)) {
      super.delete(jobId);
      return false;
    }
    return true;
  }

  override set(jobId: string, job: AsyncRemediationJob): this {
    if (super.has(jobId)) {
      super.set(jobId, job);
      return this;
    }

    // Lazy cleanup of any expired jobs before capacity check
    this.evictExpired();

    if (this.size >= this.maxCapacity) {
      this.evictOneCandidate();
    }

    super.set(jobId, job);
    return this;
  }

  private evictOneCandidate(): void {
    let oldestTerminalId: string | undefined;
    let oldestTerminalTime = Infinity;

    let oldestOverallId: string | undefined;
    let oldestOverallTime = Infinity;

    for (const [id, job] of super.entries()) {
      const submittedMs = new Date(job.submittedAt).getTime() || 0;
      if (submittedMs < oldestOverallTime) {
        oldestOverallTime = submittedMs;
        oldestOverallId = id;
      }

      if (job.status === "done" || job.status === "failed") {
        const terminalMs = new Date(job.completedAt ?? job.submittedAt).getTime() || 0;
        if (terminalMs < oldestTerminalTime) {
          oldestTerminalTime = terminalMs;
          oldestTerminalId = id;
        }
      }
    }

    const targetId = oldestTerminalId ?? oldestOverallId;
    if (targetId) {
      super.delete(targetId);
    }
  }

  private enforceCapacity(): void {
    this.evictExpired();
    while (this.size > this.maxCapacity) {
      this.evictOneCandidate();
    }
  }

  public stats(): JobRegistryStats {
    let pending = 0;
    let running = 0;
    let done = 0;
    let failed = 0;
    for (const job of super.values()) {
      switch (job.status) {
        case "pending":
          pending++;
          break;
        case "running":
          running++;
          break;
        case "done":
          done++;
          break;
        case "failed":
          failed++;
          break;
      }
    }
    return {
      size: this.size,
      maxCapacity: this.maxCapacity,
      ttlMs: this.ttlMs,
      pending,
      running,
      done,
      failed,
    };
  }
}

export const jobRegistry = new BoundedJobRegistry();
