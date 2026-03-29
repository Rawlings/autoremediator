import { describe, expect, it } from "vitest";
import { createEvidenceLog } from "./evidence.js";

describe("createEvidenceLog", () => {
  it("propagates correlation context into evidence", () => {
    const log = createEvidenceLog("/tmp/project", ["CVE-2021-23337"], {
      requestId: "req-123",
      sessionId: "session-abc",
      parentRunId: "parent-1",
    });

    expect(log.requestId).toBe("req-123");
    expect(log.sessionId).toBe("session-abc");
    expect(log.parentRunId).toBe("parent-1");
    expect(log.cveIds).toEqual(["CVE-2021-23337"]);
    expect(log.runId).toMatch(/^\d+-[a-z0-9]{6}$/);
    expect(log.summary).toBeUndefined();
  });
});
