export interface ReachabilityEvidence {
  filePath: string;
  matchType: "import" | "require" | "dynamic-import" | "re-export" | "manifest";
  importedSymbols?: string[];
  symbol?: string;
  invoked?: boolean;
  callCount?: number;
}

export interface ReachabilityAssessment {
  packageName: string;
  status: "reachable" | "not-reachable" | "unknown";
  reason: string;
  reachabilityBasis?:
    | "import-present"
    | "symbol-present"
    | "call-path-found"
    | "call-graph-uninvoked"
    | "transitive-path-found"
    | "runtime-call-observed"
    | "runtime-load-observed"
    | "unknown";

  justification?: "code_not_in_execute_path" | "code_not_reachable" | (string & {});
  evidence?: ReachabilityEvidence[];
  /** Where the verdict came from: the static source scan, a runtime trace, or both. */
  evidenceKind?: ReachabilityEvidenceKind;
  /** The static scan's status, kept when runtime evidence changed `status`. */
  staticStatus?: "reachable" | "not-reachable" | "unknown";
  /** What a runtime trace (`traceFile`) showed. Present only when a trace was supplied. */
  runtime?: RuntimeReachability;
}

export type ReachabilityEvidenceKind = "static" | "runtime" | "both";

/**
 * What a traced run showed about one package. `not-loaded-in-tests` is not proof that the package
 * is unreachable: it only says the traced command never loaded it.
 */
export type RuntimeReachabilityVerdict =
  | "not-loaded-in-tests"
  | "loaded-in-tests"
  | "loaded-not-called-in-tests"
  | "called-in-tests"
  | "no-trace-data";

export interface RuntimeReachability {
  verdict: RuntimeReachabilityVerdict;
  reason: string;
  /** What the verdict does and does not establish. */
  caveat: string;
  /** Versions of the package the trace saw loaded. */
  versions?: string[];
  /** What loaded it: packages, or `(app)` for the project's own code. */
  loadedBy?: string[];
  /** Calls counted for the requested symbol (or for any export when no symbol was asked for). */
  calls?: { symbol?: string; count: number };
  /** The traced command's exit code, when the trace records it. */
  exitCode?: number | null;
}

/** Options for checkReachability() */
export interface CheckReachabilityOptions {
  cwd?: string;
  packageName: string;
  symbol?: string;
  /** A trace from `traceRun` / `autoremediator trace run` (folded JSON or raw JSONL); adds runtime evidence. */
  traceFile?: string;
}
