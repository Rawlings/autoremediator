import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { discoverProjectFiles } from "../../../infra/rollback/rollback.js";
import { sha256 } from "../../../shared/hash.js";
import type { RunRecord, RunStore } from "../../runs/run-store.js";

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
/** Identifiers for the two predicates; type URIs name a schema, they are not fetched. */
export const RUN_PREDICATE_TYPE =
  "https://github.com/Rawlings/autoremediator/attestations/run-ledger/v1";
export const PACK_PREDICATE_TYPE =
  "https://github.com/Rawlings/autoremediator/attestations/evidence-pack/v1";

export interface Subject {
  name: string;
  digest: { sha256: string };
}

export interface Statement {
  _type: typeof STATEMENT_TYPE;
  subject: Subject[];
  predicateType: string;
  predicate: Record<string, unknown>;
}

/** The project's manifests, lockfiles, patch files and tsconfig files as they are now, by sha256. */
export function projectSubjects(cwd: string): Subject[] {
  return discoverProjectFiles(cwd)
    .map((file) => relative(cwd, file).split(sep).join("/"))
    .toSorted()
    .flatMap((name) => {
      try {
        return [{ name, digest: { sha256: sha256(readFileSync(join(cwd, name))) } }];
      } catch {
        return [];
      }
    });
}

type ItemOutcome = "applied" | "failed" | "rejected" | "not-attempted";

export type RunStatement =
  | { ok: true; statement: Statement; ledgerHead: string }
  | { ok: false; reason: string };

/**
 * An in-toto statement about one recorded run: the subjects are the project's manifests and
 * lockfiles as they are now; the predicate is the run's plan, what happened to each item, the
 * verifier's results, and the head of the hash-chained ledger. A run whose ledger does not verify
 * is refused, because an attestation of a tampered record would vouch for nothing.
 */
export function buildRunStatement(input: {
  store: RunStore;
  run: RunRecord;
  subjects: Subject[];
  /** The project's current `filesSha256`, to say whether the project still matches where the run ended. */
  currentFilesSha256?: string;
  toolVersion: string;
  now: Date;
}): RunStatement {
  const { store, run } = input;
  const ledger = store.ledger(run.runId);
  const check = ledger.verify();
  if (!check.ok) {
    return {
      ok: false,
      reason: `ledger failed verification at event ${check.seq}: ${check.reason}`,
    };
  }
  if (input.subjects.length === 0) {
    return { ok: false, reason: "no manifest or lockfile was found to attest to" };
  }
  const events = ledger.read();
  const head = events.at(-1);

  const outcomes = new Map<
    string,
    { outcome: ItemOutcome; verified?: boolean; failedCheck?: string }
  >();
  for (const event of events) {
    const itemId = typeof event.data["itemId"] === "string" ? event.data["itemId"] : undefined;
    if (!itemId) continue;
    if (event.type === "item.done") {
      outcomes.set(itemId, {
        outcome: event.data["status"] === "applied" ? "applied" : "failed",
        verified: event.data["verified"] === true,
      });
    } else if (event.type === "item.rejected") {
      outcomes.set(itemId, {
        outcome: "rejected",
        ...(typeof event.data["failedCheck"] === "string"
          ? { failedCheck: event.data["failedCheck"] }
          : {}),
      });
    } else if (event.type === "item.error") {
      outcomes.set(itemId, { outcome: "failed" });
    }
  }

  const plan = store.readPlan(run.runId);
  let verification: unknown;
  let verificationSha256: string | undefined;
  if (store.hasFile(run.runId, "verification.json")) {
    const raw = readFileSync(join(store.runDir(run.runId), "verification.json"), "utf8");
    verificationSha256 = sha256(raw);
    const parsed = JSON.parse(raw) as {
      passed?: boolean;
      failedCheck?: string;
      checks?: Array<{ name: string; status: string }>;
    };
    verification = {
      passed: parsed.passed === true,
      ...(parsed.failedCheck ? { failedCheck: parsed.failedCheck } : {}),
      checks: (parsed.checks ?? []).map((entry) => ({ name: entry.name, status: entry.status })),
      sha256: verificationSha256,
    };
  }

  const ledgerFile = join(store.runDir(run.runId), "steps.jsonl");
  const predicate = {
    generator: { name: "autoremediator", version: input.toolVersion },
    attestedAt: input.now.toISOString(),
    run: {
      runId: run.runId,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.source ? { source: run.source } : {}),
      cveIds: run.cveIds,
      ...(run.planId ? { planId: run.planId } : {}),
      base: run.base,
      ...(run.after ? { after: run.after } : {}),
      ...(input.currentFilesSha256 && (run.after ?? run.base)
        ? { projectMatchesRunEnd: input.currentFilesSha256 === (run.after ?? run.base).filesSha256 }
        : {}),
    },
    items: (plan?.items ?? []).map((item) => {
      const seen = outcomes.get(item.itemId);
      return {
        itemId: item.itemId,
        cveId: item.cveId,
        packageName: item.packageName,
        fromVersion: item.fromVersion,
        toVersion: item.toVersion,
        strategy: item.strategy,
        rollback: item.rollback,
        outcome: seen?.outcome ?? "not-attempted",
        verified: seen?.verified,
        failedCheck: seen?.failedCheck,
      };
    }),
    skipped: (plan?.skipped ?? []).map((skip) => ({
      cveId: skip.cveId,
      packageName: skip.packageName,
      fromVersion: skip.fromVersion,
      reason: skip.reason,
    })),
    verification: verification ?? null,
    ledger: {
      file: `.autoremediator/runs/${run.runId}/steps.jsonl`,
      sha256: sha256(readFileSync(ledgerFile)),
      events: events.length,
      chainVerified: true,
      headHash: head?.hash ?? null,
    },
  };

  return {
    ok: true,
    ledgerHead: head?.hash ?? "",
    statement: {
      _type: STATEMENT_TYPE,
      subject: input.subjects,
      predicateType: RUN_PREDICATE_TYPE,
      predicate,
    },
  };
}
