import { randomUUID } from "node:crypto";
import { jobRegistry } from "../../platform/jobs.js";
import type { AsyncRemediationJob, JobHandle } from "../../platform/jobs.js";
import type {
  RemediateOptions,
  PortfolioTarget,
  RemediationReport,
  PortfolioReport,
} from "../../platform/types.js";
import type { ScanReport, ScanOptions } from "../contracts.js";
import { remediate } from "../remediate/index.js";
import { remediateFromScan } from "../remediate-from-scan/index.js";
import { remediatePortfolio } from "../portfolio/index.js";

export type { JobHandle, AsyncRemediationJob } from "../../platform/jobs.js";

export type TypedAsyncRemediationJob = Omit<AsyncRemediationJob, "result"> & {
  result?: RemediationReport | ScanReport | PortfolioReport;
};

function createJob(): AsyncRemediationJob {
  const jobId = randomUUID();
  const submittedAt = new Date().toISOString();
  const job: AsyncRemediationJob = { jobId, status: "pending", submittedAt };
  jobRegistry.set(jobId, job);
  return job;
}

function runJobAsync(job: AsyncRemediationJob, work: () => Promise<unknown>): void {
  Promise.resolve()
    .then(() => {
      job.status = "running";
      return work();
    })
    .then((result) => {
      job.status = "done";
      job.result = result;
      job.completedAt = new Date().toISOString();
    })
    .catch((error: unknown) => {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = new Date().toISOString();
    });
}

export function submitRemediateJob(cveId: string, options?: RemediateOptions): JobHandle {
  const job = createJob();
  runJobAsync(job, () => remediate(cveId, options));
  return { jobId: job.jobId, status: job.status, submittedAt: job.submittedAt };
}

export function submitScanJob(inputPath: string, options?: ScanOptions): JobHandle {
  const job = createJob();
  runJobAsync(job, () => remediateFromScan(inputPath, options));
  return { jobId: job.jobId, status: job.status, submittedAt: job.submittedAt };
}

export function submitPortfolioJob(
  targets: PortfolioTarget[],
  options?: RemediateOptions,
): JobHandle {
  const job = createJob();
  runJobAsync(job, () => remediatePortfolio(targets, options));
  return { jobId: job.jobId, status: job.status, submittedAt: job.submittedAt };
}

export function pollJob(jobId: string): TypedAsyncRemediationJob {
  const job = jobRegistry.get(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  return job as TypedAsyncRemediationJob;
}
