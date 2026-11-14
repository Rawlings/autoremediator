import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { RepoFingerprint } from "./fingerprint.js";
import { isAttemptId, isRunId, newRunId } from "./ids.js";
import { Ledger } from "./ledger.js";
import type { RemediationReport } from "../platform/types.js";
import type { RemediationPlan } from "./plan.js";

export type RunStatus =
  | "planned"
  | "applying"
  | "applied"
  | "partial"
  | "failed"
  | "rolled-back";

export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  status: RunStatus;
  cwd: string;
  cveIds: string[];
  source?: string;
  createdAt: string;
  updatedAt: string;
  planId?: string;
  /** An agent repaired project source in this run, so a verification must allow source edits. */
  allowSourceEdits?: boolean;
  /** Inputs the plan was made against. */
  base: RepoFingerprint;
  /** Inputs as the last completed step left them; a rollback is only safe while they still match. */
  after?: RepoFingerprint;
  error?: string;
}

export type AttemptStatus =
  | "open"
  | "abandoned"
  | "verified"
  | "rejected"
  | "failed"
  | "promoted"
  | "promotion-failed";

/** One try, by an agent, at making an upgrade work. */
export interface AttemptRecord {
  attemptId: string;
  itemId: string;
  agentId: string;
  status: AttemptStatus;
  /** What happened, in a sentence: the agent's summary, or why it was rejected. */
  reason: string;
  /** Times the verifier's findings were handed back to the agent. */
  rounds: number;
  changedFiles: string[];
  /** An open attempt's checkout: where a host agent edits. Gone once the attempt is closed. */
  worktreePath?: string;
  inputTokens?: number;
  outputTokens?: number;
  startedAt: string;
  endedAt: string;
}

export interface RunInit {
  cwd: string;
  cveIds: string[];
  source?: string;
  planId?: string;
  base: RepoFingerprint;
  status?: RunStatus;
}

/** Run records live in `<project>/.autoremediator/runs/<runId>/`. */
export class RunStore {
  readonly cwd: string;
  readonly root: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.root = join(cwd, ".autoremediator", "runs");
  }

  /** Directory of a run; the id is validated, so it can never point outside `root`. */
  runDir(runId: string): string {
    if (!isRunId(runId)) throw new Error(`Invalid run id: ${JSON.stringify(runId)}`);
    return join(this.root, runId);
  }

  create(init: RunInit): RunRecord {
    const runId = newRunId();
    mkdirSync(this.runDir(runId), { recursive: true });
    const now = new Date().toISOString();
    const record: RunRecord = {
      schemaVersion: 1,
      runId,
      status: init.status ?? "planned",
      cwd: init.cwd,
      cveIds: init.cveIds,
      ...(init.source ? { source: init.source } : {}),
      createdAt: now,
      updatedAt: now,
      ...(init.planId ? { planId: init.planId } : {}),
      base: init.base,
    };
    this.writeJson(runId, "run.json", record);
    return record;
  }

  exists(runId: string): boolean {
    return existsSync(join(this.runDir(runId), "run.json"));
  }

  load(runId: string): RunRecord {
    if (!this.exists(runId)) throw new Error(`Run not found: ${runId}`);
    return JSON.parse(readFileSync(join(this.runDir(runId), "run.json"), "utf8")) as RunRecord;
  }

  update(runId: string, patch: Partial<Omit<RunRecord, "runId" | "schemaVersion">>): RunRecord {
    const next: RunRecord = {
      ...this.load(runId),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.writeJson(runId, "run.json", next);
    return next;
  }

  /** Newest first. Unreadable run directories are skipped rather than failing the listing. */
  list(): RunRecord[] {
    if (!existsSync(this.root)) return [];
    const records: RunRecord[] = [];
    for (const name of readdirSync(this.root)) {
      if (!isRunId(name)) continue;
      try {
        records.push(this.load(name));
      } catch {
        // A half-written or damaged run is not worth hiding the others for.
      }
    }
    return records.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  ledger(runId: string): Ledger {
    return new Ledger(join(this.runDir(runId), "steps.jsonl"));
  }

  hasFile(runId: string, name: string): boolean {
    return existsSync(join(this.runDir(runId), name));
  }

  /** The run's plan, when it has one. */
  readPlan(runId: string): RemediationPlan | undefined {
    const file = join(this.runDir(runId), "plan.json");
    return existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as RemediationPlan)
      : undefined;
  }

  /** The preview report a plan was made from, when the run has one. */
  readReport(runId: string): RemediationReport | undefined {
    const file = join(this.runDir(runId), "report.json");
    return existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as RemediationReport)
      : undefined;
  }

  /** Directory of one attempt; both ids are validated. */
  attemptDir(runId: string, attemptId: string): string {
    if (!isAttemptId(attemptId)) throw new Error(`Invalid attempt id: ${JSON.stringify(attemptId)}`);
    return join(this.runDir(runId), "attempts", attemptId);
  }

  /** An attempt's record and the files that explain it (`diff.patch`, `transcript.jsonl`, ...). */
  writeAttempt(runId: string, record: AttemptRecord, files: Record<string, string> = {}): void {
    const dir = this.attemptDir(runId, record.attemptId);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, "utf8");
    this.writeJson(runId, `attempts/${record.attemptId}/attempt.json`, record);
  }

  listAttempts(runId: string): AttemptRecord[] {
    const root = join(this.runDir(runId), "attempts");
    if (!existsSync(root)) return [];
    const records: AttemptRecord[] = [];
    for (const name of readdirSync(root)) {
      if (!isAttemptId(name)) continue;
      try {
        records.push(JSON.parse(readFileSync(join(root, name, "attempt.json"), "utf8")) as AttemptRecord);
      } catch {
        // Skip a damaged attempt rather than hiding the others.
      }
    }
    return records.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** Write atomically (temp file, then rename), so readers never see a half-written file. */
  writeJson(runId: string, name: string, value: unknown): void {
    const target = join(this.runDir(runId), name);
    const temp = `${target}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temp, target);
  }

  /**
   * Take the run's apply lock. The lock records the owning process; one whose process has died is
   * taken over, so a crashed apply can be resumed.
   */
  acquireApplyLock(runId: string): () => void {
    const lockFile = join(this.runDir(runId), "apply.lock");
    const claim = () => writeFileSync(lockFile, String(process.pid), { flag: "wx" });
    try {
      claim();
    } catch {
      const owner = Number.parseInt(readFileSync(lockFile, "utf8"), 10);
      if (Number.isFinite(owner) && isAlive(owner)) {
        throw new Error(`Run ${runId} is already being applied (process ${owner}).`);
      }
      rmSync(lockFile, { force: true });
      claim();
    }
    return () => rmSync(lockFile, { force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
