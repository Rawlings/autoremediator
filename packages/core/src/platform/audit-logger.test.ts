import { describe, expect, it, vi } from "vitest";
import {
  clearAuditSinks,
  emitAuditEvent,
  registerAuditSink,
  toCefString,
  type AuditEvent,
} from "./audit-logger.js";

describe("audit-logger", () => {
  it("emits structured audit events with UUID and ISO timestamp", () => {
    const sink = vi.fn();
    const unsubscribe = registerAuditSink(sink);

    const event = emitAuditEvent({
      actor: "test-user",
      action: "remediation.applied",
      cveId: "CVE-2021-23337",
      packageName: "lodash",
      severity: "HIGH",
      disposition: "auto-apply",
    });

    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.timestamp).toBeDefined();
    expect(event.action).toBe("remediation.applied");
    expect(sink).toHaveBeenCalledWith(event);

    unsubscribe();
  });

  it("formats audit event as CEF string", () => {
    const event: AuditEvent = {
      eventId: "12345",
      timestamp: "2026-08-21T18:00:00.000Z",
      actor: "ci-bot",
      action: "policy.blocked",
      cveId: "CVE-2024-1234",
      packageName: "express",
      severity: "CRITICAL",
      disposition: "escalate",
    };

    const cef = toCefString(event);
    expect(cef).toContain("CEF:0|Autoremediator|Core|1.0|policy.blocked|policy.blocked|CRITICAL|");
    expect(cef).toContain("cve=CVE-2024-1234");
    expect(cef).toContain("pkg=express");
    expect(cef).toContain("act=ci-bot");
  });

  it("handles failing sinks gracefully without throwing", () => {
    clearAuditSinks();
    registerAuditSink(() => {
      throw new Error("Sink error");
    });

    expect(() =>
      emitAuditEvent({
        actor: "system",
        action: "containment.triggered",
        cveId: "CVE-2023-9999",
      }),
    ).not.toThrow();
  });
});
