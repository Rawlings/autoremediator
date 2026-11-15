import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  npmLock,
  PACKAGE_JSON,
  SECRET_VALUES,
  writeSecretBearingFiles,
  type TestRepo,
  makeRepo,
} from "../incident/__tests__/repo.js";
import { discoverRepos, premortem } from "./index.js";
import { shellQuote } from "./playbook.js";

const PNPM_LOCK = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      mid:
        specifier: ^1.0.0
        version: 1.0.0

packages:
  mid@1.0.0:
    resolution: {integrity: sha512-m}
  evil-lib@1.0.3:
    resolution: {integrity: sha512-e}

snapshots:
  mid@1.0.0:
    dependencies:
      evil-lib: 1.0.3
  evil-lib@1.0.3: {}
`;

let a: TestRepo;
let b: TestRepo;
let c: TestRepo;
let out: string;

beforeEach(() => {
  // a: npm lock, CI that installs with secrets in reach, and a package that runs install scripts.
  a = makeRepo("premortem-a");
  a.write("package.json", PACKAGE_JSON);
  a.write(
    "package-lock.json",
    npmLock("1.0.3", { "node_modules/native-lib": { version: "2.0.0", hasInstallScript: true } }),
  );
  writeSecretBearingFiles(a);
  a.commit("init", "2026-01-01T10:00:00Z");

  // b: pnpm lock whose lockfile does not flag install scripts, but the installed copy has one.
  b = makeRepo("premortem-b");
  b.write("package.json", PACKAGE_JSON);
  b.write("pnpm-lock.yaml", PNPM_LOCK);
  b.write(
    "node_modules/evil-lib/package.json",
    JSON.stringify({
      name: "evil-lib",
      version: "1.0.3",
      scripts: { postinstall: "node setup.js" },
    }),
  );
  b.commit("init", "2026-01-01T10:00:00Z");

  // c: does not use any of it.
  c = makeRepo("premortem-c");
  c.write("package.json", JSON.stringify({ name: "c", dependencies: {} }));
  c.write(
    "package-lock.json",
    JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "c" } } }),
  );
  c.commit("init", "2026-01-01T10:00:00Z");

  out = mkdtempSync(join(tmpdir(), "premortem-out-"));
});
afterEach(() => {
  for (const repo of [a, b, c]) repo.cleanup();
  rmSync(out, { recursive: true, force: true });
});

const targets = () => [
  { cwd: a.dir, label: "repo-a" },
  { cwd: b.dir, label: "repo-b" },
  { cwd: c.dir, label: "repo-c" },
];

describe("premortem: blast radius", () => {
  it("says which repositories lock each named package, how, in which versions, and what an install runs", async () => {
    const report = await premortem({ targets: targets(), packages: ["evil-lib", "absent-pkg"] });
    expect(report.selection).toEqual({ mode: "given" });

    const evil = report.packages.find((entry) => entry.packageName === "evil-lib")!;
    expect(evil).toMatchObject({ repoCount: 2, dependentCount: 1, installScript: true });
    expect(evil.usage).toEqual([
      {
        repo: "repo-a",
        versions: ["1.0.3"],
        direct: false,
        scope: "production",
        installScript: true,
      },
      // From the installed copy's package.json: the pnpm lockfile does not flag it.
      {
        repo: "repo-b",
        versions: ["1.0.3"],
        direct: false,
        scope: "production",
        installScript: true,
      },
    ]);
    // Only repo-a has CI that installs with secrets in reach.
    expect(evil.reposWithCiSecrets).toEqual(["repo-a"]);

    expect(report.packages.find((entry) => entry.packageName === "absent-pkg")).toMatchObject({
      repoCount: 0,
      usage: [],
    });
    expect(report.notes.join(" ")).toMatch(/absent-pkg is not locked in any of the 3 repositories/);

    const repoA = report.repos.find((repo) => repo.label === "repo-a")!;
    expect(repoA.ci).toMatchObject({ installs: true });
    expect(repoA.ci.secretNames).toEqual(
      expect.arrayContaining(["NPM_PUBLISH_TOKEN", "DEPLOY_KEY", "GLOBAL_SECRET"]),
    );
    expect(report.repos.find((repo) => repo.label === "repo-b")?.ci).toMatchObject({
      installs: false,
      secretNames: [],
    });
  });

  it("picks the most depended-upon packages by default, and the most privileged on request", async () => {
    const byReach = await premortem({ targets: targets(), top: 2 });
    expect(byReach.selection).toEqual({ mode: "ranked", rankBy: "depended-upon", top: 2 });
    // evil-lib is in two repositories; mid too, but evil-lib has a dependent and mid has none.
    expect(byReach.packages.map((entry) => entry.packageName)).toEqual(["evil-lib", "mid"]);

    const byPrivilege = await premortem({ targets: targets(), top: 1, rankBy: "privileged" });
    // Both evil-lib (by its installed copy) and native-lib (by the lockfile) run scripts; evil-lib is in more repositories.
    expect(byPrivilege.packages.map((entry) => entry.packageName)).toEqual(["evil-lib"]);
    const onlyLocked = await premortem({
      targets: [targets()[0]!, targets()[2]!],
      top: 1,
      rankBy: "privileged",
    });
    expect(onlyLocked.packages[0]?.installScript).toBe(true);
  });

  it("finds repositories under a root and does not follow symlinks or enter node_modules", async () => {
    const root = mkdtempSync(join(tmpdir(), "premortem-root-"));
    try {
      for (const name of ["one", "group/two", "node_modules/skipped"]) {
        const dir = join(root, name);
        mkdirSync(dir, { recursive: true });
        execFileSync("git", ["init", "-q", dir]);
        writeFileSync(join(dir, "package.json"), PACKAGE_JSON);
      }
      expect(discoverRepos(root).map((target) => target.label)).toEqual(["group/two", "one"]);
      const report = await premortem({ root, packages: ["mid"] });
      expect(report.repos.map((repo) => repo.label)).toEqual(["group/two", "one"]);
      expect(report.repos[0]?.notes.join(" ")).toMatch(/no lockfile could be read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails loudly on nothing to read or a target that is not a directory", async () => {
    await expect(premortem({})).rejects.toThrow(/Name the repositories/);
    await expect(premortem({ root: out })).rejects.toThrow(/No repository .* found under/);
    await expect(premortem({ targets: [{ cwd: join(out, "missing") }] })).rejects.toThrow(
      /is not a directory/,
    );
  });

  it("counts a checkout named twice once, and keeps labels unique", async () => {
    const report = await premortem({
      targets: [
        { cwd: a.dir, label: "x" },
        { cwd: a.dir, label: "y" },
        { cwd: b.dir, label: "x" },
      ],
      packages: ["mid"],
    });
    expect(report.repos.map((repo) => repo.label)).toEqual(["x", "x-2"]);
  });
});

describe("premortem: playbooks", () => {
  it("writes a playbook per repository with the exact commands, plus a summary and the JSON", async () => {
    const outputDir = join(out, "ops");
    const report = await premortem({ targets: targets(), packages: ["evil-lib"], outputDir });
    expect(report.files).toHaveLength(5);
    expect(readdirSync(join(outputDir, "playbooks"))).toHaveLength(3);

    const summary = readFileSync(join(outputDir, "premortem.md"), "utf8");
    expect(summary).toContain("| `evil-lib` | 2 | 1 | **yes** | repo-a |");
    expect(JSON.parse(readFileSync(join(outputDir, "premortem.json"), "utf8"))).toMatchObject({
      schemaVersion: "1.0",
      files: expect.any(Array),
    });

    const playbookA = readFileSync(
      join(
        outputDir,
        "playbooks",
        readdirSync(join(outputDir, "playbooks")).find((name) => name.startsWith("repo-a"))!,
      ),
      "utf8",
    );
    expect(playbookA).toContain(
      `autoremediator incident 'evil-lib@1.0.3' --cwd ${shellQuote(a.dir)} --output-dir './incident-evil-lib'`,
    );
    expect(playbookA).toContain("autoremediator incident '<advisory id>'");
    expect(playbookA).toContain("`NPM_PUBLISH_TOKEN`");
    expect(playbookA).toContain("--plan");
    const playbookC = readFileSync(
      join(
        outputDir,
        "playbooks",
        readdirSync(join(outputDir, "playbooks")).find((name) => name.startsWith("repo-c"))!,
      ),
      "utf8",
    );
    expect(playbookC).toContain("None of the assessed packages is locked here.");
  });

  it("can write one playbook per package instead", async () => {
    const outputDir = join(out, "by-package");
    await premortem({
      targets: targets(),
      packages: ["evil-lib", "mid"],
      playbooks: "package",
      outputDir,
    });
    const names = readdirSync(join(outputDir, "playbooks"));
    expect(names).toHaveLength(2);
    const text = readFileSync(
      join(
        outputDir,
        "playbooks",
        names.find((name) => name.startsWith("evil-lib"))!,
      ),
      "utf8",
    );
    expect(text).toContain("### repo-a");
    expect(text).toContain("### repo-b");
    expect(text).not.toContain("### repo-c");
  });

  it("never lets a secret value into the report, the playbooks or the summary", async () => {
    const outputDir = join(out, "hostile");
    const report = await premortem({ targets: targets(), packages: ["evil-lib"], outputDir });
    const written = [
      JSON.stringify(report),
      ...report.files!.map((file) => readFileSync(file, "utf8")),
    ].join("\n");
    for (const value of SECRET_VALUES) expect(written).not.toContain(value);
    expect(written).not.toContain("REAL_SECRET");
    expect(written).toContain("NPM_PUBLISH_TOKEN");
  });

  it("quotes a hostile path and label so a playbook command cannot break out", async () => {
    const evil = mkdtempSync(join(tmpdir(), "it's `bad`-"));
    try {
      writeFileSync(join(evil, "package.json"), PACKAGE_JSON);
      writeFileSync(join(evil, "package-lock.json"), npmLock("1.0.3"));
      const outputDir = join(out, "quoted");
      await premortem({
        targets: [{ cwd: evil, label: "bad|label\n## INJECTED" }],
        packages: ["evil-lib"],
        outputDir,
      });
      const dir = join(outputDir, "playbooks");
      const text = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
      expect(text).not.toMatch(/^## INJECTED/m);
      expect(text).toContain(String.raw`'\''`);
      // The path's backtick and quote cannot end the fence or the quoted argument early.
      expect(text.split("```").length % 2).toBe(1);
      expect(existsSync(join(outputDir, "premortem.md"))).toBe(true);
    } finally {
      rmSync(evil, { recursive: true, force: true });
    }
  });
});

describe("shellQuote", () => {
  it("wraps in single quotes and escapes embedded ones", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(String.raw`'it'\''s'`);
  });
});
