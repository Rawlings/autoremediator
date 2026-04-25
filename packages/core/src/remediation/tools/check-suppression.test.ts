import { describe, expect, it } from "vitest";
import { checkSuppressionTool } from "./check-suppression.js";

type SuppressionEntry = {
  cveId: string;
  justification: "not_affected" | "fixed" | "mitigated" | "under_investigation";
  notes?: string;
  expiresAt?: string;
};

async function callTool(cveId: string, suppressions: SuppressionEntry[]) {
  return (checkSuppressionTool as unknown as {
    execute: (args: { cveId: string; suppressions: SuppressionEntry[] }) => Promise<{
      suppressed: boolean;
      justification?: string;
      notes?: string;
    }>;
  }).execute({ cveId, suppressions });
}

describe("check-suppression tool", () => {
  it("returns suppressed=true for an active matching suppression", async () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    const result = await callTool("CVE-2024-0001", [
      { cveId: "CVE-2024-0001", justification: "not_affected", expiresAt: future },
    ]);
    expect(result.suppressed).toBe(true);
    expect(result.justification).toBe("not_affected");
  });

  it("returns suppressed=false for an expired suppression", async () => {
    const past = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
    const result = await callTool("CVE-2024-0001", [
      { cveId: "CVE-2024-0001", justification: "mitigated", expiresAt: past },
    ]);
    expect(result.suppressed).toBe(false);
  });

  it("returns suppressed=false when no matching suppression exists", async () => {
    const result = await callTool("CVE-2024-9999", [
      { cveId: "CVE-2024-0001", justification: "not_affected" },
    ]);
    expect(result.suppressed).toBe(false);
  });

  it("returns suppressed=true for suppression with no expiresAt (always active)", async () => {
    const result = await callTool("CVE-2024-0002", [
      { cveId: "CVE-2024-0002", justification: "fixed", notes: "Patched internally" },
    ]);
    expect(result.suppressed).toBe(true);
    expect(result.notes).toBe("Patched internally");
  });
});
