import type { ModeName, LoadedTask } from "../task.ts";
import type { Project } from "../workspace.ts";

export interface ModeContext {
  task: LoadedTask;
  project: Project;
  /** Scratch space for this task and mode; removed afterwards unless `--keep` is given. */
  workDir: string;
  registryUrl: string;
  /** The hermetic environment variables, for spawned servers. */
  hermeticEnv: Record<string, string>;
  /** `agent-model` only: `<provider>:<model-id>`. */
  model?: string;
}

/** What a mode reports about its own run. The oracle decides what it is worth. */
export interface ModeOutcome {
  /** The run reported that a fix was applied to the project. */
  claimedSuccess: boolean;
  /** `unresolvedReason` of every planned or applied result for the advisory. */
  unresolvedReasons: string[];
  /** Model turns (agent modes) or MCP tool calls (host mode). */
  steps: number;
  agentClaimedSuccess?: boolean;
  tokens?: { input: number; output: number };
  notes: string[];
}

export interface Mode {
  name: ModeName;
  /** What a result from this mode does and does not measure. Printed with the results. */
  description: string;
  run: (context: ModeContext) => Promise<ModeOutcome>;
}
