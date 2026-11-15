import { describe, expect, it } from "vitest";

import { codeScanningAlertTarget, dependabotAlertTarget } from "./alerts.js";

describe("dependabotAlertTarget", () => {
  it("prefers the CVE and reads severity and package", () => {
    expect(
      dependabotAlertTarget({
        alert: {
          security_advisory: {
            cve_id: "CVE-2021-23337",
            ghsa_id: "GHSA-35jh-r3h4-6jhm",
            severity: "high",
          },
          dependency: { package: { name: "lodash" } },
        },
      }),
    ).toEqual({ advisoryIds: ["CVE-2021-23337"], severity: "high", packageName: "lodash" });
  });

  it("falls back to the GHSA id", () => {
    expect(
      dependabotAlertTarget({
        alert: { security_advisory: { cve_id: null, ghsa_id: "GHSA-35jh-r3h4-6jhm" } },
      })?.advisoryIds,
    ).toEqual(["GHSA-35JH-R3H4-6JHM"]);
  });

  it("returns nothing for a missing or malformed advisory", () => {
    expect(dependabotAlertTarget({})).toBeUndefined();
    expect(
      dependabotAlertTarget({ alert: { security_advisory: { cve_id: "not-an-id; rm" } } }),
    ).toBeUndefined();
  });
});

describe("codeScanningAlertTarget", () => {
  it("uses a CVE rule id", () => {
    expect(
      codeScanningAlertTarget({
        alert: { rule: { id: "CVE-2022-1234", security_severity_level: "critical" } },
      }),
    ).toEqual({ advisoryIds: ["CVE-2022-1234"], severity: "critical" });
  });

  it("ignores alerts that are not advisories", () => {
    expect(
      codeScanningAlertTarget({ alert: { rule: { id: "js/sql-injection" } } }),
    ).toBeUndefined();
  });
});
