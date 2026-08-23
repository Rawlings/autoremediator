import { describe, expect, it } from "vitest";
import { checkReachability } from "./index.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixtureDir = join(__dirname, "../../../");

describe("checkReachability public SDK", () => {
  it("traces reachability for existing package in core", async () => {
    const result = await checkReachability({
      cwd: fixtureDir,
      packageName: "semver",
    });

    expect(result.packageName).toBe("semver");
    expect(result.status).toBe("reachable");
    expect(result.evidence?.length).toBeGreaterThan(0);
  });

  it("reports not-reachable for unreferenced package", async () => {
    const result = await checkReachability({
      cwd: fixtureDir,
      packageName: "definitely-non-existent-pkg-xyz",
    });

    expect(result.packageName).toBe("definitely-non-existent-pkg-xyz");
    expect(result.status).toBe("not-reachable");
    expect(result.justification).toBe("code_not_in_execute_path");
  });
});
