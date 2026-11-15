import { execSync } from "node:child_process";
import { mkdtempSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateAndApplyPatch } from "./patch-apply.js";

let dir: string;
const git = (command: string): string => execSync(`git ${command}`, { cwd: dir, encoding: "utf8" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "patch-apply-"));
  git("init -q -b main");
  git("config user.name t");
  git("config user.email t@example.com");
  writeFileSync(join(dir, "package.json"), '{"name":"app"}\n');
  writeFileSync(join(dir, "b.js"), "module.exports = 1;\n");
  symlinkSync("b.js", join(dir, "a.js"));
  git("add -A");
  git('commit -q -m init');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("validateAndApplyPatch", () => {
  it("refuses a patch that retargets an existing symbolic link", async () => {
    unlinkSync(join(dir, "a.js"));
    symlinkSync("../../../../etc/passwd", join(dir, "a.js"));
    const diff = git("diff");
    git("checkout -- a.js");
    expect(diff).toMatch(/^index \S+ 120000/m);

    await expect(validateAndApplyPatch(dir, diff)).rejects.toThrow(/symbolic links/);
    expect(readlinkSync(join(dir, "a.js"))).toBe("b.js");
  });

  it("still applies an ordinary source patch", async () => {
    writeFileSync(join(dir, "b.js"), "module.exports = 2;\n");
    const diff = git("diff");
    git("checkout -- b.js");
    const applied = await validateAndApplyPatch(dir, diff);
    expect(applied.files).toEqual(["b.js"]);
  });
});
