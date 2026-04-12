import { describe, expect, it, vi } from "vitest";
import { createDefaultRemediationHandler } from "./remediation-handler.js";

const { remediateFromScanMock } = vi.hoisted(() => ({
  remediateFromScanMock: vi.fn(async () => ({
    schemaVersion: "1.0",
    status: "ok",
    generatedAt: new Date().toISOString(),
    cveIds: [],
    reports: [],
    successCount: 0,
    failedCount: 0,
    errors: [],
    patchCount: 0,
  })),
}));

vi.mock("autoremediator", () => ({
  remediateFromScan: remediateFromScanMock,
}));

describe("createDefaultRemediationHandler", () => {
  it("calls core scan remediation in audit mode", async () => {
    const handler = createDefaultRemediationHandler({
      cwd: "./demo-vuln-app",
      dryRun: false,
    });

    await handler({
      eventName: "check_suite",
      deliveryId: "delivery-core-1",
      installationId: 123,
      payload: {},
    });

    expect(remediateFromScanMock).toHaveBeenCalledTimes(1);
    expect(remediateFromScanMock).toHaveBeenCalledWith("", {
      cwd: "./demo-vuln-app",
      audit: true,
      dryRun: false,
    });
  });
});
