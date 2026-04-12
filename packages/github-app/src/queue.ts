import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { QueueJob } from "./types.js";

interface QueueJobInput {
  eventName: QueueJob["eventName"];
  installationId?: number;
  deliveryId?: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  maxAttempts: number;
  nextRunAt?: string;
}

interface JobQueue {
  enqueue(input: QueueJobInput): QueueJob;
  claimDueJobs(limit: number): QueueJob[];
  completeJob(jobId: string): void;
  failJob(jobId: string, error: string, retryDelayMs: number): QueueJob | undefined;
  listJobs(): QueueJob[];
}

interface PersistedQueueState {
  schemaVersion: number;
  jobs: QueueJob[];
}

const QUEUE_SCHEMA_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function sortJobs(jobs: QueueJob[]): QueueJob[] {
  return [...jobs].sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
}

function isRetryable(job: QueueJob): boolean {
  return job.attempts < job.maxAttempts;
}

export function createInMemoryJobQueue(initialJobs: QueueJob[] = []): JobQueue {
  const jobs = new Map<string, QueueJob>();

  for (const job of initialJobs) {
    jobs.set(job.id, { ...job });
  }

  const getActiveByDedupeKey = (dedupeKey: string): QueueJob | undefined => {
    for (const job of jobs.values()) {
      if (job.dedupeKey !== dedupeKey) {
        continue;
      }

      if (job.status === "queued" || job.status === "running") {
        return job;
      }
    }

    return undefined;
  };

  return {
    enqueue(input: QueueJobInput): QueueJob {
      if (input.dedupeKey) {
        const existing = getActiveByDedupeKey(input.dedupeKey);
        if (existing) {
          return existing;
        }
      }

      const createdAt = nowIso();
      const job: QueueJob = {
        id: randomUUID(),
        eventName: input.eventName,
        installationId: input.installationId,
        deliveryId: input.deliveryId,
        payload: input.payload,
        dedupeKey: input.dedupeKey,
        status: "queued",
        attempts: 0,
        maxAttempts: input.maxAttempts,
        nextRunAt: input.nextRunAt ?? createdAt,
        createdAt,
        updatedAt: createdAt,
      };

      jobs.set(job.id, job);
      return job;
    },

    claimDueJobs(limit: number): QueueJob[] {
      if (limit <= 0) {
        return [];
      }

      const now = Date.now();
      const dueJobs = sortJobs(
        Array.from(jobs.values()).filter((job) => job.status === "queued" && Date.parse(job.nextRunAt) <= now)
      ).slice(0, limit);

      const claimedAt = nowIso();
      for (const job of dueJobs) {
        job.status = "running";
        job.attempts += 1;
        job.updatedAt = claimedAt;
        jobs.set(job.id, job);
      }

      return dueJobs;
    },

    completeJob(jobId: string): void {
      const job = jobs.get(jobId);
      if (!job) {
        return;
      }

      job.status = "completed";
      job.updatedAt = nowIso();
      jobs.set(job.id, job);
    },

    failJob(jobId: string, error: string, retryDelayMs: number): QueueJob | undefined {
      const job = jobs.get(jobId);
      if (!job) {
        return undefined;
      }

      const updatedAt = nowIso();
      job.lastError = error;
      job.updatedAt = updatedAt;

      if (isRetryable(job)) {
        job.status = "queued";
        job.nextRunAt = new Date(Date.now() + retryDelayMs).toISOString();
      } else {
        job.status = "failed";
      }

      jobs.set(job.id, job);
      return job;
    },

    listJobs(): QueueJob[] {
      return sortJobs(Array.from(jobs.values()));
    },
  };
}

function loadQueueState(filePath: string): QueueJob[] {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedQueueState;
    if (parsed.schemaVersion !== QUEUE_SCHEMA_VERSION || !Array.isArray(parsed.jobs)) {
      return [];
    }

    return parsed.jobs;
  } catch {
    return [];
  }
}

function persistQueueState(filePath: string, queue: JobQueue): void {
  const snapshot: PersistedQueueState = {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    jobs: queue.listJobs(),
  };

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export function createFileBackedJobQueue(filePath: string): JobQueue {
  const memoryQueue = createInMemoryJobQueue(loadQueueState(filePath));

  return {
    enqueue(input: QueueJobInput): QueueJob {
      const job = memoryQueue.enqueue(input);
      persistQueueState(filePath, memoryQueue);
      return job;
    },
    claimDueJobs(limit: number): QueueJob[] {
      const jobs = memoryQueue.claimDueJobs(limit);
      if (jobs.length > 0) {
        persistQueueState(filePath, memoryQueue);
      }
      return jobs;
    },
    completeJob(jobId: string): void {
      memoryQueue.completeJob(jobId);
      persistQueueState(filePath, memoryQueue);
    },
    failJob(jobId: string, error: string, retryDelayMs: number): QueueJob | undefined {
      const job = memoryQueue.failJob(jobId, error, retryDelayMs);
      persistQueueState(filePath, memoryQueue);
      return job;
    },
    listJobs(): QueueJob[] {
      return memoryQueue.listJobs();
    },
  };
}

export type { JobQueue, QueueJobInput };
