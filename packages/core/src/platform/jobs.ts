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

export const jobRegistry = new Map<string, AsyncRemediationJob>();
