/**
 * Shapes shared by the trace hook (which runs inside the traced program), the fold that merges its
 * output, and the reachability verdict. Nothing here imports from the rest of the package: the hook
 * must stay small because it loads into every process of the traced command.
 */

/** Environment variables the hook reads. They are inherited by every child process of the command. */
export const TRACE_ENV = {
  /** Where the hook appends JSONL records. Without it the hook does nothing. */
  file: "AUTOREMEDIATOR_TRACE_FILE",
  /** Comma-separated package names whose exported functions are wrapped to count calls. */
  packages: "AUTOREMEDIATOR_TRACE_PACKAGES",
  /** `1` turns call counting on for the listed packages. */
  calls: "AUTOREMEDIATOR_TRACE_CALLS",
} as const;

export const TRACE_SCHEMA = "autoremediator.trace/v1";

/** Marks how a module was loaded. */
export type ModuleFormat = "cjs" | "esm";

/** First record a process writes. */
export interface TraceProcessRecord {
  v: 1;
  t: "proc";
  pid: number;
  /** True for the main thread, false for a worker thread. */
  main: boolean;
  at: string;
  node: string;
  /** Whether call counting was requested for this process. */
  calls: boolean;
  /** Packages whose exports the process was asked to wrap. */
  listed: string[];
  /**
   * `hooks` when `module.registerHooks` was available (ESM and CJS both observed), `cjs-only` on
   * older runtimes, where imports of ES modules are not seen.
   */
  observes: "hooks" | "cjs-only";
}

/** One installed package the process loaded. Idempotent: folding unions the sets. */
export interface TracePackageRecord {
  v: 1;
  t: "pkg";
  name: string;
  version: string;
  /** Files, relative to the package root, that code outside the package loaded. */
  entries: string[];
  /** Packages (or `(app)` for the project's own code) that loaded those entries. */
  dependents: string[];
  formats: ModuleFormat[];
}

/** Call counts since the last flush, so folding sums them. */
export interface TraceCallsRecord {
  v: 1;
  t: "calls";
  name: string;
  version: string;
  calls: Record<string, number>;
  /** Export names whose calls are counted. */
  wrapped: string[];
  /** Export name to the reason it could not be counted. */
  unwrapped: Record<string, string>;
}

export type TraceRecord = TraceProcessRecord | TracePackageRecord | TraceCallsRecord;

/** One package in the folded trace. */
export interface TracePackage {
  name: string;
  version: string;
  entries: string[];
  dependents: string[];
  formats: ModuleFormat[];
  /** Calls to each wrapped export, summed across processes. Present when call counting ran. */
  calls?: Record<string, number>;
  /** Exports whose calls are counted (a count of 0 means "wrapped and never called"). */
  wrapped?: string[];
  /** Exports that could not be counted, with the reason. */
  unwrapped?: Record<string, string>;
}

/** The merged result of a traced run. Written by `traceRun` and accepted as `traceFile`. */
export interface TraceReport {
  schema: typeof TRACE_SCHEMA;
  createdAt: string;
  /** The traced command and how it ended, when the trace came from `traceRun`. */
  command?: { argv: string[]; exitCode: number | null; signal?: string };
  /** Number of processes and worker threads that reported. 0 means the hook never ran. */
  processes: number;
  /** True if any process only observed CommonJS. */
  partialEsm: boolean;
  callTracing: { enabled: boolean; packages: string[] };
  /** JSONL lines that could not be parsed and were skipped. */
  skippedLines: number;
  packages: TracePackage[];
}
