import type { JobQueue } from "./queue.js";

interface SchedulerOptions {
  queue: JobQueue;
  intervalMs: number;
  queueMaxAttempts: number;
}

interface SchedulerHandle {
  stop: () => void;
}

function buildScheduleBucket(nowMs: number, intervalMs: number): string {
  return String(Math.floor(nowMs / intervalMs));
}

export function startWorkflowDispatchScheduler(options: SchedulerOptions): SchedulerHandle {
  const tick = (): void => {
    const nowMs = Date.now();
    const bucket = buildScheduleBucket(nowMs, options.intervalMs);
    options.queue.enqueue({
      eventName: "workflow_dispatch",
      payload: {
        source: "scheduler",
        scheduledAt: new Date(nowMs).toISOString(),
      },
      deliveryId: `schedule-${bucket}`,
      dedupeKey: `scheduler-${bucket}`,
      maxAttempts: options.queueMaxAttempts,
    });
  };

  tick();
  const interval = setInterval(tick, options.intervalMs);

  return {
    stop: () => {
      clearInterval(interval);
    },
  };
}

export type { SchedulerHandle, SchedulerOptions };
