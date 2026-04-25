import { describe, expect, it } from "vitest";
import { computeEscalationAction, DEFAULT_ESCALATION_GRAPH } from "./escalation.js";

describe("DEFAULT_ESCALATION_GRAPH", () => {
  it("defines required default actions", () => {
    expect(DEFAULT_ESCALATION_GRAPH["consensus-failed"]).toBe("create-draft-pr");
    expect(DEFAULT_ESCALATION_GRAPH["patch-validation-failed"]).toBe("open-issue");
    expect(DEFAULT_ESCALATION_GRAPH["patch-confidence-too-low"]).toBe("open-issue");
    expect(DEFAULT_ESCALATION_GRAPH["source-fetch-failed"]).toBe("notify-channel");
    expect(DEFAULT_ESCALATION_GRAPH["patch-generation-failed"]).toBe("notify-channel");
    expect(DEFAULT_ESCALATION_GRAPH["no-safe-version"]).toBe("open-issue");
    expect(DEFAULT_ESCALATION_GRAPH["validation-failed"]).toBe("create-draft-pr");
  });
});

describe("computeEscalationAction", () => {
  it("returns none when reason is undefined", () => {
    expect(computeEscalationAction(undefined)).toBe("none");
  });

  it("uses platform defaults when graph is omitted", () => {
    expect(computeEscalationAction("no-safe-version")).toBe("open-issue");
    expect(computeEscalationAction("transitive-dependency")).toBe("none");
  });

  it("merges caller graph over defaults", () => {
    const graph = {
      "no-safe-version": "create-draft-pr",
      "source-fetch-failed": "hold-branch",
    } as const;

    expect(computeEscalationAction("no-safe-version", graph)).toBe("create-draft-pr");
    expect(computeEscalationAction("source-fetch-failed", graph)).toBe("hold-branch");
    expect(computeEscalationAction("patch-validation-failed", graph)).toBe("open-issue");
  });

  it("treats an empty graph as defaults", () => {
    expect(computeEscalationAction("patch-generation-failed", {})).toBe("notify-channel");
  });
});
