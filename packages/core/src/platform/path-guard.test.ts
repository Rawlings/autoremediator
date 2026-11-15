import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertPathsConfined,
  confinePaths,
  PathNotAllowedError,
  type PathGuardSchema,
} from "./path-guard.js";

const path = { type: "string", "x-path": true } as const;
const schema: PathGuardSchema = {
  properties: {
    cwd: path,
    inputPath: path,
    patchesDir: path,
    suppressionsFile: path,
    intelligenceSnapshotPath: path,
    policy: path,
    patchFilePath: path,
    reproductionTest: path,
    outDir: path,
    signingKeyPath: path,
    traceFile: path,
    note: { type: "string" },
    cveId: { type: "string" },
    targets: { items: { properties: { cwd: path, inputPath: path } } },
    options: { properties: { cwd: path } },
  },
};

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

  const forbidden = PathNotAllowedError;
  const check = (body: unknown) => () => assertPathsConfined(schema, body, [root], root);

  it("allows paths inside an allowed root, including not-yet-created ones", () => {
    expect(() =>
      assertPathsConfined(
        schema,
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
    ]) {
      expect(check({ cwd: root, [key]: join(outside, "x") })).toThrow(forbidden);
    }
  });

  it("checks paths nested in arrays and sub-objects (portfolio targets)", () => {
    expect(check({ targets: [{ cwd: join(root, "project") }, { cwd: outside }] })).toThrow(
      forbidden,
    );
    expect(check({ options: { cwd: outside } })).toThrow(forbidden);
  });

  it("blocks symlinks that escape the allowed root", () => {
    symlinkSync(outside, join(root, "escape"));
    expect(check({ cwd: join(root, "escape") })).toThrow(forbidden);
    expect(check({ cwd: root, patchesDir: "escape/patches" })).toThrow(forbidden);
  });

  it("ignores non-path fields and non-string values", () => {
    expect(() =>
      assertPathsConfined(schema, { cveId: "CVE-2024-1", note: outside, cwd: 5 }, [root], root),
    ).not.toThrow();
  });

  it("only guards fields the schema tags as paths", () => {
    expect(() =>
      assertPathsConfined(
        { properties: { other: { type: "string" } } },
        { other: outside },
        [root],
        root,
      ),
    ).not.toThrow();
  });

  it("treats a multi-line value as inline content, not a path", () => {
    expect(() =>
      check({ cwd: root, reproductionTest: "const a = 1;\nprocess.exit(a);" })(),
    ).not.toThrow();
    expect(() => check({ cwd: root, policy: "---\nallowMajorBumps: false\n" })()).not.toThrow();
    expect(() => check({ cwd: root, policy: '{\n"allowMajorBumps": false\n}' })()).not.toThrow();
    expect(check({ cwd: root, reproductionTest: join(outside, "test.js") })).toThrow(forbidden);
  });

  it("names the offending field", () => {
    expect(check({ patchesDir: outside })).toThrow(/"patchesDir"/);
  });

  it("refuses a newline in any other path field, since it hides `..` from the check", () => {
    const hostile = "x\n/../../../../../../../../../tmp/pwned";
    for (const field of ["cwd", "outDir", "signingKeyPath", "traceFile", "inputPath"]) {
      expect(() => check({ cwd: root, [field]: hostile })()).toThrow(PathNotAllowedError);
    }
    // `policy` only gets the exemption when the value reads as inline YAML or JSON.
    expect(() => check({ cwd: root, policy: hostile })()).toThrow(PathNotAllowedError);
  });
});

describe("confinePaths", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "confine-")));
    mkdirSync(join(root, "a", "b"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("hands handlers the absolute path that was checked, so no handler resolves it differently", () => {
    const cwd = join(root, "a", "b");
    const out = confinePaths(
      schema,
      { cwd, inputPath: "../scan.json", targets: [{ cwd: "../../a" }] },
      [root],
      root,
    );
    expect(out.cwd).toBe(cwd);
    expect(out.inputPath).toBe(join(root, "a", "scan.json"));
    expect(out.targets[0]?.cwd).toBe(join(root, "a"));
  });

  it("leaves inline content untouched and does not mutate its input", () => {
    const input = {
      cwd: root,
      policy: "---\nallowMajorBumps: false\n",
      reproductionTest: "process.exit(1)",
    };
    const copy = structuredClone(input);
    const out = confinePaths(schema, input, [root], root);
    expect(out.policy).toBe(input.policy);
    expect(out.reproductionTest).toBe("process.exit(1)");
    expect(input).toEqual(copy);
  });

  it("still refuses what assertPathsConfined refuses", () => {
    expect(() =>
      confinePaths(schema, { cwd: root, inputPath: "../../../etc/passwd" }, [root], root),
    ).toThrow(PathNotAllowedError);
  });
});
