import { describe, it, expect } from "vitest";
import { applyDispositionAndContainment, computeDisposition } from "./disposition.js";
import type { DispositionSignals, DispositionPolicy } from "../../platform/types.js";

const base: DispositionSignals = { applied: false };

describe("computeDisposition", () => {
  it("escalates on regression detected", () => {
    const r = computeDisposition({ ...base, applied: true, regressionDetected: true });
    expect(r).toEqual({ disposition: "escalate", dispositionReason: "regression-detected" });
  });

  it("escalates on consensus failed", () => {
    const r = computeDisposition({ ...base, consensusFailed: true });
    expect(r).toEqual({ disposition: "escalate", dispositionReason: "consensus-failed" });
  });

  it("escalates on validation-failed", () => {
    const r = computeDisposition({ ...base, unresolvedReason: "validation-failed" });
    expect(r).toEqual({ disposition: "escalate", dispositionReason: "validation-failed" });
  });

  it("escalates on patch-validation-failed", () => {
    const r = computeDisposition({ ...base, unresolvedReason: "patch-validation-failed" });
    expect(r).toEqual({ disposition: "escalate", dispositionReason: "patch-validation-failed" });
  });

  it("escalates on install-failed", () => {
    const r = computeDisposition({ ...base, unresolvedReason: "install-failed" });
    expect(r).toEqual({ disposition: "escalate", dispositionReason: "install-failed" });
  });

  it("escalates on kev exploit signal by default", () => {
    const r = computeDisposition({ ...base, exploitSignalTriggered: true });
    expect(r).toEqual({ disposition: "escalate", dispositionReason: "kev-exploit-signal" });
  });

  it("does not escalate on kev exploit when escalateOnKev is false", () => {
    const r = computeDisposition(
      { ...base, applied: true, exploitSignalTriggered: true },
      { escalateOnKev: false }
    );
    expect(r.disposition).toBe("auto-apply");
  });

  it("escalates on sla breach for CRITICAL", () => {
    const r = computeDisposition({
      ...base,
      slaBreaches: [{ cveId: "CVE-2024-1234", severity: "CRITICAL", publishedAt: "2024-01-01T00:00:00Z", deadlineAt: "2024-01-08T00:00:00Z", hoursOverdue: 24 }],
    });
    expect(r).toEqual({ disposition: "escalate", dispositionReason: "sla-breach" });
  });

  it("does not escalate on sla breach for LOW severity", () => {
    const r = computeDisposition({
      ...base,
      applied: true,
      slaBreaches: [{ cveId: "CVE-2024-1234", severity: "LOW", publishedAt: "2024-01-01T00:00:00Z", deadlineAt: "2024-01-08T00:00:00Z", hoursOverdue: 2 }],
    });
    expect(r.disposition).toBe("auto-apply");
  });

  it("holds for patch-confidence-too-low", () => {
    const r = computeDisposition({ ...base, unresolvedReason: "patch-confidence-too-low" });
    expect(r).toEqual({ disposition: "hold-for-approval", dispositionReason: "patch-confidence-too-low" });
  });

  it("holds for transitive when holdForTransitive is enabled", () => {
    const policy: DispositionPolicy = { holdForTransitive: true };
    const r = computeDisposition({ ...base, applied: true, dependencyScope: "transitive" }, policy);
    expect(r).toEqual({ disposition: "hold-for-approval", dispositionReason: "transitive-dependency" });
  });

  it("does not hold for transitive by default", () => {
    const r = computeDisposition({ ...base, applied: true, dependencyScope: "transitive" });
    expect(r.disposition).toBe("auto-apply");
  });

  it("returns simulate-only when not applied with unresolved reason", () => {
    const r = computeDisposition({ ...base, unresolvedReason: "no-safe-version" });
    expect(r).toEqual({ disposition: "simulate-only", dispositionReason: "no-safe-version" });
  });

  it("holds for approval when applied but confidence below threshold", () => {
    const r = computeDisposition({ ...base, applied: true, confidence: 0.5 });
    expect(r).toEqual({ disposition: "hold-for-approval", dispositionReason: "low-confidence" });
  });

  it("holds using custom minConfidenceForAutoApply threshold", () => {
    const policy: DispositionPolicy = { minConfidenceForAutoApply: 0.9 };
    const r = computeDisposition({ ...base, applied: true, confidence: 0.8 }, policy);
    expect(r).toEqual({ disposition: "hold-for-approval", dispositionReason: "low-confidence" });
  });

  it("auto-applies when applied and confidence meets threshold", () => {
    const r = computeDisposition({ ...base, applied: true, confidence: 0.85 });
    expect(r).toEqual({ disposition: "auto-apply", dispositionReason: "safe-apply" });
  });

  it("auto-applies when applied with no confidence provided", () => {
    const r = computeDisposition({ ...base, applied: true });
    expect(r).toEqual({ disposition: "auto-apply", dispositionReason: "safe-apply" });
  });

  it("defaults to simulate-only for unresolved with no reason", () => {
    const r = computeDisposition({ ...base });
    expect(r).toEqual({ disposition: "simulate-only", dispositionReason: "unresolved" });
  });
});

describe("applyDispositionAndContainment", () => {
  it("blocks applied escalate result when containment mode is enabled", () => {
    const result = applyDispositionAndContainment(
      {
        packageName: "pkg",
        fromVersion: "1.0.0",
        strategy: "version-bump",
        applied: true,
        dryRun: false,
        message: "ok",
      },
      {
        containmentMode: true,
        exploitSignalTriggered: true,
      }
    );

    expect(result.disposition).toBe("escalate");
    expect(result.applied).toBe(false);
    expect(result.unresolvedReason).toBe("policy-blocked");
  });

  it("applies disposition without containment mutation when disabled", () => {
    const result = applyDispositionAndContainment(
      {
        packageName: "pkg",
        fromVersion: "1.0.0",
        strategy: "version-bump",
        applied: true,
        dryRun: false,
        message: "ok",
      },
      {
        containmentMode: false,
        exploitSignalTriggered: true,
      }
    );

    expect(result.disposition).toBe("escalate");
    expect(result.applied).toBe(true);
    expect(result.unresolvedReason).toBeUndefined();
  });
});
