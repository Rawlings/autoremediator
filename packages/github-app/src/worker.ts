import type { JobQueue } from "./queue.js";
import type { QueueJob } from "./types.js";

interface StartJobWorkerOptions {
  queue: JobQueue;
  pollIntervalMs: number;
  concurrency: number;
  retryDelayMs: number;
  processJob: (job: QueueJob) => Promise<void>;
  onJobFailed?: (job: QueueJob) => void;
}

interface JobWorkerHandle {
  stop: () => void;
}

export function startJobWorker(options: StartJobWorkerOptions): JobWorkerHandle {
  let inFlight = 0;
  let stopped = false;

  const poll = async (): Promise<void> => {
    if (stopped || inFlight >= options.concurrency) {
      return;
    }

    const availableSlots = options.concurrency - inFlight;
    const jobs = options.queue.claimDueJobs(availableSlots);
    if (jobs.length === 0) {
      return;
    }

    await Promise.all(
      jobs.map(async (job) => {
        inFlight += 1;
        try {
          await options.processJob(job);
          options.queue.completeJob(job.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const updatedJob = options.queue.failJob(job.id, message, options.retryDelayMs);
          if (updatedJob) {
            options.onJobFailed?.(updatedJob);
          }
        } finally {
          inFlight -= 1;
        }
      })
    );
  };

  const interval = setInterval(() => {
    void poll();
  }, options.pollIntervalMs);

  void poll();

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

export type { JobWorkerHandle, StartJobWorkerOptions };
