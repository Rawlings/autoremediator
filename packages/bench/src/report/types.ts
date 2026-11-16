import type { LoadedTask } from "../task.ts";
import type { LoadedResult } from "./load.ts";

/** Everything the results pages are generated from. */
export interface ReportInput {
  results: readonly LoadedResult[];
  tasks: readonly LoadedTask[];
  /** The instant the corpus registry state is frozen at, when the corpus has been fetched. */
  snapshotDate?: string;
}
