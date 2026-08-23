import { randomUUID } from "node:crypto";

export type AuditAction =
  | "remediation.started"
  | "remediation.applied"
  | "remediation.failed"
  | "policy.blocked"
  | "policy.escalated"
  | "containment.triggered"
  | "patch.synthesized"
  | "patch.validated"
  | "vex.generated";

export interface AuditEvent {
  eventId: string;
  timestamp: string;
  actor: string;
  action: AuditAction;
  cveId?: string;
  packageName?: string;
  repository?: string;
  severity?: string;
  disposition?: string;
  metadata?: Record<string, unknown>;
}

export type AuditSink = (event: AuditEvent) => void;

const sinks: Set<AuditSink> = new Set();

/**
 * Register an audit event sink (e.g. SIEM webhook forwarder, structured file logger).
 */
export function registerAuditSink(sink: AuditSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

/**
 * Clears all registered audit sinks (primarily for tests).
 */
export function clearAuditSinks(): void {
  sinks.clear();
}

/**
 * Format audit event as Common Event Format (CEF) string.
 */
export function toCefString(event: AuditEvent): string {
  const extension = [
    event.cveId ? `cve=${encodeURIComponent(event.cveId)}` : "",
    event.packageName ? `pkg=${encodeURIComponent(event.packageName)}` : "",
    event.repository ? `repo=${encodeURIComponent(event.repository)}` : "",
    event.disposition ? `disp=${encodeURIComponent(event.disposition)}` : "",
    `act=${encodeURIComponent(event.actor)}`,
  ]
    .filter(Boolean)
    .join(" ");

  return `CEF:0|Autoremediator|Core|1.0|${event.action}|${event.action}|${event.severity ?? "INFO"}|${extension}`;
}

/**
 * Emits a structured SIEM-compatible audit log event.
 */
export function emitAuditEvent(event: Omit<AuditEvent, "eventId" | "timestamp">): AuditEvent {
  const fullEvent: AuditEvent = {
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    ...event,
  };

  for (const sink of sinks) {
    try {
      sink(fullEvent);
    } catch {
      // Sinks must not crash the remediation pipeline
    }
  }

  return fullEvent;
}
