import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertPathsConfined } from "./path-guard.js";

describe("assertPathsConfined", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "guard-root-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "guard-outside-")));
    mkdirSync(join(root, "project"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const forbidden = expect.objectContaining({ status: 403 });
  const check = (body: unknown) => () => assertPathsConfined(body, [root], root);

  it("allows paths inside an allowed root, including not-yet-created ones", () => {
    expect(() =>
      assertPathsConfined(
        { cwd: join(root, "project"), patchesDir: "patches", inputPath: "scan.json" },
        [root],
        root,
      ),
    ).not.toThrow();
  });

  it("rejects an absolute cwd outside the roots", () => {
    expect(check({ cwd: outside })).toThrow(forbidden);
  });

  it("rejects relative traversal out of the roots", () => {
    expect(check({ cwd: join(root, "project"), inputPath: "../../../../etc/passwd" })).toThrow(
      forbidden,
    );
  });

  it("checks every path-valued option, not just cwd", () => {
    for (const key of [
      "inputPath",
      "patchesDir",
      "suppressionsFile",
      "intelligenceSnapshotPath",
      "policy",
      "patchFilePath",
      "evidenceFile",
    ]) {
      expect(check({ cwd: root, [key]: join(outside, "x") })).toThrow(forbidden);
    }
  });

  it("checks paths nested in arrays and sub-objects (portfolio targets)", () => {
    expect(check({ targets: [{ path: join(root, "project") }, { path: outside }] })).toThrow(
      forbidden,
    );
    expect(check({ options: { nested: { cwd: outside } } })).toThrow(forbidden);
  });

  it("blocks symlinks that escape the allowed root", () => {
    symlinkSync(outside, join(root, "escape"));
    expect(check({ cwd: join(root, "escape") })).toThrow(forbidden);
    expect(check({ cwd: root, patchesDir: "escape/patches" })).toThrow(forbidden);
  });

  it("ignores non-path fields and non-string values", () => {
    expect(() =>
      assertPathsConfined({ cveId: "CVE-2024-1", note: outside, cwd: 5 }, [root], root),
    ).not.toThrow();
  });
});
