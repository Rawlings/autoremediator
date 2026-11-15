/**
 * In-memory store of finished A2A tasks. Bounded three ways (count, age and total bytes) so a caller
 * with a low-privilege token cannot fill the server's memory, and every task is bound to the caller
 * that ran it.
 */
import type { Role } from "../platform/http-auth.js";

export interface TaskLimits {
  maxTasks: number;
  maxBytes: number;
  ttlMs: number;
}

export interface StoredTask<T> {
  task: T;
  /** The role that ran it: reading the result needs the same. */
  role: Role;
  /** Who ran it (`callerIdentity`): nobody else may read it, whatever their role. */
  owner: string;
  storedAt: number;
  bytes: number;
}

export class TaskStore<T extends { id: string }> {
  private readonly entries = new Map<string, StoredTask<T>>();
  private total = 0;
  private readonly limits: TaskLimits;

  constructor(limits: TaskLimits) {
    this.limits = limits;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.total;
  }

  private drop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.total -= entry.bytes;
    this.entries.delete(id);
  }

  /** Keep `task`; returns false (storing nothing) when it alone is bigger than the whole byte budget. */
  remember(task: T, role: Role, owner: string, now = Date.now()): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(task));
    if (bytes > this.limits.maxBytes) return false;
    this.drop(task.id);
    // Oldest first: a Map iterates in insertion order.
    for (const [id, entry] of this.entries) {
      const expired = now - entry.storedAt > this.limits.ttlMs;
      const full =
        this.entries.size >= this.limits.maxTasks || this.total + bytes > this.limits.maxBytes;
      if (!expired && !full) break;
      this.drop(id);
    }
    this.entries.set(task.id, { task, role, owner, storedAt: now, bytes });
    this.total += bytes;
    return true;
  }

  get(id: string, now = Date.now()): StoredTask<T> | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (now - entry.storedAt > this.limits.ttlMs) {
      this.drop(id);
      return undefined;
    }
    return entry;
  }
}

interface MessagePart {
  text?: string;
  data?: unknown;
  mediaType?: string;
}

interface MessageLike {
  messageId?: string;
  contextId?: string;
  taskId?: string;
  role?: string;
  parts: MessagePart[];
}

export const MAX_KEPT_MESSAGE_BYTES = 2048;

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/**
 * A short copy of a caller's message for the task record: the ids and role, then text and data parts
 * in order until the byte budget is spent. Text is cut, data that does not fit is replaced by a
 * marker, and anything else (files, raw bytes, URLs) is dropped.
 */
export function truncateMessage<M extends MessageLike>(
  message: M,
  maxBytes = MAX_KEPT_MESSAGE_BYTES,
): M {
  const { parts } = message;
  const head: Record<string, string> = {};
  for (const key of ["messageId", "contextId", "taskId", "role"] as const) {
    const value = message[key];
    if (typeof value === "string") head[key] = value.slice(0, 200);
  }
  let remaining = maxBytes - byteLength({ ...head, parts: [] });
  const kept: MessagePart[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const mediaType =
      typeof part.mediaType === "string" ? { mediaType: part.mediaType.slice(0, 100) } : {};
    if (typeof part.text === "string") {
      const budget = Math.max(0, remaining - 64);
      const text = part.text.length > budget ? `${part.text.slice(0, budget)}...[truncated]` : part.text;
      const copy = { text, ...mediaType };
      kept.push(copy);
      remaining -= byteLength(copy) + 1;
    } else if ("data" in part) {
      const whole = { data: part.data, ...mediaType };
      const size = byteLength(whole);
      const copy =
        size <= remaining
          ? whole
          : { data: { truncated: true, bytes: size }, ...mediaType };
      kept.push(copy);
      remaining -= byteLength(copy) + 1;
    }
    if (remaining <= 0) break;
  }
  return { ...head, parts: kept } as unknown as M;
}
