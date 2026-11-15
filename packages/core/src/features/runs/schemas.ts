/**
 * What a run directory is allowed to contain. Files here are written by this tool but read back
 * later, possibly after a crash, a manual edit or an upgrade, so they are parsed rather than cast:
 * the fields the store and the apply flow rely on are checked, nested structures are only required
 * to be objects.
 */
import { z } from "zod";

import { isRecord } from "../../shared/guards.js";
import type { RemediationReport } from "../remediate/types.js";
import type { RepoFingerprint } from "./fingerprint.js";
import type { StepEvent } from "./ledger.js";
import type { RemediationPlan } from "./plan.js";
import type { AttemptRecord, RunRecord } from "./run-store.js";

const object = <T>(): z.ZodType<T> => z.custom<T>(isRecord, "expected an object");

const fingerprintSchema = object<RepoFingerprint>();

export const runRecordSchema: z.ZodType<RunRecord> = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  status: z.enum(["planned", "applying", "applied", "partial", "failed", "rolled-back"]),
  cwd: z.string(),
  cveIds: z.array(z.string()),
  source: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  planId: z.string().optional(),
  allowSourceEdits: z.boolean().optional(),
  base: fingerprintSchema,
  after: fingerprintSchema.optional(),
  error: z.string().optional(),
});

export const attemptRecordSchema: z.ZodType<AttemptRecord> = z.object({
  attemptId: z.string(),
  itemId: z.string(),
  agentId: z.string(),
  status: z.enum([
    "open",
    "abandoned",
    "verified",
    "rejected",
    "failed",
    "promoted",
    "promotion-failed",
  ]),
  reason: z.string(),
  rounds: z.number(),
  changedFiles: z.array(z.string()),
  worktreePath: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  startedAt: z.string(),
  endedAt: z.string(),
});

export const stepEventSchema: z.ZodType<StepEvent> = z.object({
  seq: z.number().int(),
  at: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  prevHash: z.string(),
  hash: z.string(),
});

export const planSchema = object<RemediationPlan>();
export const reportSchema = object<RemediationReport>();
