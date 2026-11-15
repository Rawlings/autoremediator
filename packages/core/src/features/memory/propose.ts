import { errorMessage } from "../../shared/errors.js";
/**
 * What an agent may do to memory: propose. A proposal is stored as a `proposed` entry that changes
 * nothing until a person runs `autoremediator memory accept <id>`. Its text is held to the same
 * rules as any entry, and also refused if it reads like an instruction.
 */
import { MEMORY_KINDS, type MemoryKind, unreachable } from "./entries.js";
import { addMemory, type NewMemoryEntry } from "./store.js";

/** The fields an agent fills in; which ones apply depends on the kind. */
export interface MemoryProposal {
  kind: MemoryKind;
  /** The command (`test-command`), the test (`flaky-test`) or the text (`install-quirk`, `note`). */
  text?: string;
  /** `pinned-package` and `rejected-upgrade`. */
  package?: string;
  fromVersion?: string;
  toVersion?: string;
  /** Why (`pinned-package`, `rejected-upgrade`) or an extra note (`flaky-test`). */
  reason?: string;
}

export const PROPOSAL_KINDS = MEMORY_KINDS;

/** At most this many proposals from one attempt. */
export const MAX_PROPOSALS_PER_ATTEMPT = 5;

const need = (proposal: MemoryProposal, field: keyof MemoryProposal): string => {
  const value = proposal[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`a ${proposal.kind} proposal needs "${field}"`);
  }
  return value;
};

/** The entry a proposal asks for, before its envelope (source, status, time) is added. */
export function entryFromProposal(proposal: MemoryProposal): NewMemoryEntry {
  switch (proposal.kind) {
    case "test-command": {
      return { kind: "test-command", command: need(proposal, "text") };
    }
    case "flaky-test": {
      return {
        kind: "flaky-test",
        test: need(proposal, "text"),
        ...(proposal.reason ? { note: proposal.reason } : {}),
      };
    }
    case "pinned-package": {
      return {
        kind: "pinned-package",
        package: need(proposal, "package"),
        reason: need(proposal, "reason"),
      };
    }
    case "rejected-upgrade": {
      return {
        kind: "rejected-upgrade",
        package: need(proposal, "package"),
        ...(proposal.fromVersion ? { fromVersion: proposal.fromVersion } : {}),
        toVersion: need(proposal, "toVersion"),
        reason: need(proposal, "reason"),
      };
    }
    case "install-quirk":
    case "note": {
      return { kind: proposal.kind, text: need(proposal, "text") };
    }
    default: {
      return unreachable(proposal.kind);
    }
  }
}

/** Store a proposal. Returns what to tell the agent; never throws for a refused proposal. */
export async function proposeMemory(
  cwd: string,
  proposal: MemoryProposal,
  origin: { runId?: string; attemptId?: string },
): Promise<string> {
  try {
    const source =
      origin.runId && /^run_[0-9a-z]{20}$/.test(origin.runId)
        ? `agent:${origin.runId}${origin.attemptId && /^attempt_[0-9a-z]{12}$/.test(origin.attemptId) ? `/${origin.attemptId}` : ""}`
        : "agent";
    const result = await addMemory(
      cwd,
      { ...entryFromProposal(proposal), status: "proposed", source },
      { untrusted: true, now: new Date() },
    );
    return result.created
      ? `Proposed ${result.entry.id}. It changes nothing until a person accepts it.`
      : `${result.entry.id} is already recorded.`;
  } catch (error) {
    return `Refused: ${errorMessage(error)}`;
  }
}
