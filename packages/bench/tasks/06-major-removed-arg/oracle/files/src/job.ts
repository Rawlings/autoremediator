import { retry } from "bench-retry";

export const runJob = (job: () => Promise<string>): Promise<string> =>
  retry(job, { attempts: 3, delayMs: 1 });
