import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getRun } from "../runs/index.js";
import {
  buildHistory,
  makeRepo,
  npmLock,
  PACKAGE_JSON,
  SECRET_VALUES,
  type TestRepo,
} from "./__tests__/repo.js";
import {
  defaultIncidentDeps,
  incident,
  incidentExitCode,
  renderIncidentMarkdown,
  type IncidentDeps,
} from "./index.js";

const NOW = Date.parse("2026-04-01T00:00:00Z");

function deps(overrides: Partial<IncidentDeps> = {}): IncidentDeps {
  return {
    target: {
      lookupOsv: vi.fn(async () => null),
      lookupGitHub: vi.fn(async () => []),
    },
    fetchPackument: vi.fn(async () => undefined),
    installed: vi.fn(async () => []),
    now: () => NOW,
    ...overrides,
  };
}

let repo: TestRepo;
let out: string;
beforeEach(() => {
  repo = makeRepo("incident");
  out = mkdtempSync(join(tmpdir(), "incident-out-"));
});
afterEach(() => {
  repo.cleanup();
  rmSync(out, { recursive: true, force: true });
});

describe("incident: exposure and history of a real git repository", () => {
  it("finds the locked version, its parent chain, and when each affected version entered and left", async () => {
    const { shas } = buildHistory(repo);
    const report = await incident("evil-lib@>=1.0.2", { cwd: repo.dir, offline: true }, deps());

    expect(report.target).toMatchObject({
      kind: "package-range",
      affected: [{ name: "evil-lib", range: ">=1.0.2" }],
    });
    expect(report.exposure.exposed).toBe(true);
    expect(report.exposure.packages[0]?.occurrences).toEqual([
      expect.objectContaining({
        version: "1.0.3",
        lockfile: "package-lock.json",
        direct: false,
        scope: "production",
        via: [".", "mid@1.0.0", "evil-lib@1.0.3"],
        dependents: ["mid@1.0.0"],
        installScript: true,
      }),
    ]);

    const history = report.history!;
    expect(history).toMatchObject({
      available: true,
      truncated: false,
      lockfiles: ["package-lock.json"],
      scannedCommits: 4,
    });
    const windows = history.packages[0]!.windows;
    expect(windows.map((window) => window.version)).toEqual(["1.0.3", "1.0.2"]);

    const bad3 = windows.find((window) => window.version === "1.0.3")!;
    expect(bad3.entered.map((commit) => commit.sha)).toEqual([shas[3]]);
    expect(bad3.entered[0]?.date).toBe("2026-03-05T10:00:00.000Z");
    expect(bad3.left).toEqual([]);
    expect(bad3.presentAtHead).toBe(true);
    expect(bad3.atTip).toEqual({ branches: ["main"], tags: ["v1.2.0"] });

    const bad2 = windows.find((window) => window.version === "1.0.2")!;
    expect(bad2.entered.map((commit) => commit.sha)).toEqual([shas[2]]);
    expect(bad2.left.map((commit) => commit.sha)).toEqual([shas[3]]);
    expect(bad2.presentAtHead).toBe(false);
    // The release branch was cut while 1.0.2 was locked, and its tip still has it.
    expect(bad2.atTip).toEqual({ branches: ["release"], tags: [] });
    expect(bad2.previousVersions).toEqual(["1.0.1"]);
    // main and v1.2.0 contain the entering commit, but their tips moved on to 1.0.3.
    expect(bad2.passedThrough).toEqual({ branches: ["main"], tags: ["v1.2.0"] });

    expect(
      history.packages[0]?.versionsSeen.map((entry) => [entry.version, entry.affected]),
    ).toEqual([
      ["1.0.3", true],
      ["1.0.2", true],
      ["1.0.1", false],
      ["1.0.0", false],
    ]);
  });

  it("reports a version that is gone from the lockfile as history only (exit code 3)", async () => {
    buildHistory(repo);
    repo.write("package-lock.json", npmLock("1.0.1"));
    const fixed = repo.commit("roll back", "2026-03-06T10:00:00Z");

    const report = await incident("evil-lib@>=1.0.2", { cwd: repo.dir, offline: true }, deps());
    expect(report.exposure.exposed).toBe(false);
    expect(incidentExitCode(report)).toBe(3);
    const window = report.history!.packages[0]!.windows.find((entry) => entry.version === "1.0.3")!;
    expect(window.left.map((commit) => commit.sha)).toEqual([fixed]);
    expect(window.presentAtHead).toBe(false);
    expect(report.rollback.proposals).toEqual([]);
    // The checklist still applies: builds in the window had the bad version.
    expect(report.secrets).toBeDefined();
  });

  it("is clear (exit code 0) when the package was never here", async () => {
    buildHistory(repo);
    const report = await incident("never-used@1.0.0", { cwd: repo.dir, offline: true }, deps());
    expect(report.exposure.exposed).toBe(false);
    expect(incidentExitCode(report)).toBe(0);
    expect(report.secrets).toBeUndefined();
    expect(renderIncidentMarkdown(report)).toContain("Not generated");
  });

  it("works without git history and says so", async () => {
    repo.write("package.json", PACKAGE_JSON);
    repo.write("package-lock.json", npmLock("1.0.3"));
    const report = await incident(
      "evil-lib@1.0.3",
      { cwd: repo.dir, offline: true, history: false },
      deps(),
    );
    expect(report.history).toBeUndefined();
    expect(report.exposure.exposed).toBe(true);
    expect(report.rollback.proposals[0]).not.toHaveProperty("toVersion");
    expect(report.rollback.proposals[0]?.reason).toMatch(
      /No known version of evil-lib older than 1.0.3/,
    );
  });

  it("says when the directory is not a git checkout", async () => {
    const plain = mkdtempSync(join(tmpdir(), "incident-plain-"));
    try {
      writeFileSync(join(plain, "package.json"), PACKAGE_JSON);
      writeFileSync(join(plain, "package-lock.json"), npmLock("1.0.3"));
      const report = await incident("evil-lib@1.0.3", { cwd: plain, offline: true }, deps());
      expect(report.history).toMatchObject({
        available: false,
        reason: expect.stringMatching(/not a git checkout/),
      });
      expect(report.exposure.exposed).toBe(true);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("bounds how much history it reads", async () => {
    buildHistory(repo);
    const report = await incident(
      "evil-lib@>=1.0.2",
      { cwd: repo.dir, offline: true, maxCommits: 2 },
      deps(),
    );
    expect(report.history).toMatchObject({ scannedCommits: 2, truncated: true });
    expect(report.history?.notes.join(" ")).toMatch(/newest 2 commits/);
  });

  it("records the declared range changes of package.json", async () => {
    repo.write(
      "package.json",
      `${JSON.stringify({ name: "app", dependencies: { mid: "^1.0.0", "evil-lib": "^1.0.0" } })}\n`,
    );
    repo.write("package-lock.json", npmLock("1.0.0"));
    repo.commit("add", "2026-01-01T10:00:00Z");
    repo.write(
      "package.json",
      `${JSON.stringify({ name: "app", dependencies: { mid: "^1.0.0", "evil-lib": "^1.0.2" } })}\n`,
    );
    repo.write("package-lock.json", npmLock("1.0.2"));
    repo.commit("bump", "2026-02-01T10:00:00Z");
    const report = await incident("evil-lib@1.0.2", { cwd: repo.dir, offline: true }, deps());
    expect(report.exposure.packages[0]).toMatchObject({ declared: "^1.0.2" });
    expect(
      report.history?.packages[0]?.manifestChanges.map((change) => [change.from, change.to]),
    ).toEqual([
      ["^1.0.0", "^1.0.2"],
      [undefined, "^1.0.0"],
    ]);
  });
});

describe("incident: rollback to the last safe version", () => {
  it("proposes the last version the project used before the bad one, as an override for a transitive copy", async () => {
    buildHistory(repo);
    const report = await incident("evil-lib@>=1.0.2", { cwd: repo.dir, offline: true }, deps());
    expect(report.rollback.proposals).toEqual([
      expect.objectContaining({
        packageName: "evil-lib",
        fromVersion: "1.0.3",
        toVersion: "1.0.1",
        strategy: "override",
        dependencyScope: "transitive",
        basis: "last-used-before",
      }),
    ]);
    expect(report.rollback.plan).toBeUndefined();
  });

  it("prefers the newest published version outside the range when the registry is consulted", async () => {
    buildHistory(repo);
    const fetchPackument = vi.fn(async () => ({
      name: "evil-lib",
      versions: { "1.0.0": {}, "1.0.1": {}, "1.0.2": {}, "1.0.3": {}, "1.0.9": {}, "2.0.0": {} },
    }));
    // Bad: 1.0.2 and 1.0.3 only, so 1.0.9 and 2.0.0 are newer unaffected releases.
    const report = await incident(
      "evil-lib@>=1.0.2 <1.0.4",
      { cwd: repo.dir },
      deps({ fetchPackument: fetchPackument as never }),
    );
    expect(fetchPackument).toHaveBeenCalledWith("evil-lib", expect.any(String));
    expect(report.rollback.proposals[0]).toMatchObject({
      toVersion: "1.0.1",
      basis: "newest-unaffected",
      newerUnaffected: "2.0.0",
    });
  });

  it("falls back to history, with a note, when the registry cannot be read", async () => {
    buildHistory(repo);
    const report = await incident(
      "evil-lib@>=1.0.2",
      { cwd: repo.dir },
      deps({
        fetchPackument: vi.fn(async () => {
          throw new Error("registry answered 503");
        }),
      }),
    );
    expect(report.rollback.proposals[0]).toMatchObject({
      toVersion: "1.0.1",
      basis: "last-used-before",
    });
    expect(report.rollback.notes.join(" ")).toMatch(/registry could not be read for evil-lib/);
  });

  it("never touches the network with offline", async () => {
    buildHistory(repo);
    const fetchPackument = vi.fn(async () => undefined);
    await incident("evil-lib@>=1.0.2", { cwd: repo.dir, offline: true }, deps({ fetchPackument }));
    expect(fetchPackument).not.toHaveBeenCalled();
  });

  it("records a plan through the run machinery whose item is an exact rollback, and applies nothing", async () => {
    buildHistory(repo);
    const dirty = () =>
      repo
        .git("status", "--porcelain")
        .split("\n")
        .filter((line) => !line.includes(".autoremediator"))
        .join("\n");
    const before = dirty();
    const report = await incident(
      "evil-lib@>=1.0.2",
      { cwd: repo.dir, offline: true, plan: true },
      deps(),
    );
    expect(report.rollback.plan).toMatchObject({
      runId: expect.stringMatching(/^run_/),
      planId: expect.stringMatching(/^plan_/),
    });

    const details = getRun({ cwd: repo.dir, runId: report.rollback.plan!.runId });
    expect(details.run.status).toBe("planned");
    expect(details.plan?.items).toEqual([
      expect.objectContaining({
        packageName: "evil-lib",
        fromVersion: "1.0.3",
        toVersion: "1.0.1",
        strategy: "override",
        dependencyScope: "transitive",
        rollback: true,
        disposition: "hold-for-approval",
      }),
    ]);
    // The advisory the verifier will check against carries the bad range.
    const advisory = JSON.parse(
      readFileSync(
        join(repo.dir, ".autoremediator", "runs", details.run.runId, "report.json"),
        "utf8",
      ),
    ) as {
      cveDetails: {
        affectedPackages: Array<{ name: string; vulnerableRange: string; source: string }>;
      };
    };
    expect(advisory.cveDetails.affectedPackages).toEqual([
      { name: "evil-lib", ecosystem: "npm", vulnerableRange: ">=1.0.2", source: "user-supplied" },
    ]);
    // Only the run record was written; the manifests and lockfile are as they were.
    expect(dirty()).toBe(before);
    expect(readFileSync(join(repo.dir, "package-lock.json"), "utf8")).toBe(npmLock("1.0.3"));
  });

  it("records no plan when there is nothing to go back to", async () => {
    repo.write("package.json", PACKAGE_JSON);
    repo.write("package-lock.json", npmLock("1.0.3"));
    repo.commit("only commit", "2026-01-01T10:00:00Z");
    const report = await incident(
      "evil-lib@>=1.0.0",
      { cwd: repo.dir, offline: true, plan: true },
      deps(),
    );
    expect(report.rollback.plan).toBeUndefined();
    expect(report.rollback.notes.join(" ")).toMatch(/No plan was recorded/);
  });
});

describe("incident: advisory ids", () => {
  it("resolves an id through the advisory lookups", async () => {
    buildHistory(repo);
    const lookupOsv = vi.fn(async () => ({
      id: "MAL-2026-1234",
      summary: "Malicious code in evil-lib",
      severity: "CRITICAL" as const,
      references: ["https://example.test/advisory"],
      affectedPackages: [
        {
          name: "evil-lib",
          ecosystem: "npm" as const,
          vulnerableRange: ">= 1.0.2, < 1.0.4",
          source: "osv" as const,
        },
      ],
    }));
    const report = await incident(
      "mal-2026-1234",
      { cwd: repo.dir, offline: false },
      deps({ target: { lookupOsv, lookupGitHub: vi.fn(async () => []) } }),
    );
    expect(lookupOsv).toHaveBeenCalledWith("MAL-2026-1234");
    expect(report.target).toMatchObject({
      kind: "advisory",
      advisory: { id: "MAL-2026-1234", source: "osv" },
      affected: [{ name: "evil-lib", range: ">= 1.0.2 < 1.0.4" }],
    });
    expect(report.exposure.exposed).toBe(true);
  });

  it("resolves an id from an intelligence snapshot when offline", async () => {
    buildHistory(repo);
    const snapshot = join(out, "snapshot.json");
    writeFileSync(
      snapshot,
      JSON.stringify({
        "GHSA-abcd-1234-wxyz": { packageName: "evil-lib", vulnerableRange: ">=1.0.2" },
      }),
    );
    const lookupOsv = vi.fn();
    const report = await incident(
      "GHSA-abcd-1234-wxyz",
      { cwd: repo.dir, offline: true, intelligenceSnapshotPath: snapshot },
      deps({ target: { lookupOsv, lookupGitHub: vi.fn() } }),
    );
    expect(lookupOsv).not.toHaveBeenCalled();
    expect(report.target.advisory).toMatchObject({
      id: "GHSA-abcd-1234-wxyz",
      source: "offline-snapshot",
    });
    expect(report.exposure.exposed).toBe(true);
  });

  it("fails loudly: id offline without a snapshot, unknown id, no range, bad range, no package.json", async () => {
    buildHistory(repo);
    await expect(incident("MAL-2026-1", { cwd: repo.dir, offline: true }, deps())).rejects.toThrow(
      /without an intelligence snapshot/,
    );
    await expect(incident("MAL-2026-1", { cwd: repo.dir }, deps())).rejects.toThrow(
      /was not found in OSV/,
    );
    await expect(incident("evil-lib", { cwd: repo.dir }, deps())).rejects.toThrow(
      /Say which versions of evil-lib are bad/,
    );
    await expect(incident("evil-lib@not-a-range", { cwd: repo.dir }, deps())).rejects.toThrow(
      /not a valid semver range/,
    );
    await expect(incident("   ", { cwd: repo.dir }, deps())).rejects.toThrow(
      /Name what was compromised/,
    );
    await expect(incident("evil-lib@1.0.0", { cwd: out }, deps())).rejects.toThrow(
      /No package.json/,
    );
  });
});

describe("incident: rotation checklist", () => {
  it("lists the names of secrets in reach of installs and writes the report files", async () => {
    buildHistory(repo);
    const outputDir = join(out, "report");
    const report = await incident(
      "evil-lib@>=1.0.2",
      { cwd: repo.dir, offline: true, outputDir },
      deps(),
    );

    const ci = report.secrets!.ci.find((file) => file.file === ".github/workflows/ci.yml")!;
    expect(ci).toMatchObject({ installs: true, installJobs: ["test"] });
    // Workflow-level, install-job and later-step secrets are in reach; the job that never installs is not.
    expect(ci.secretNames).toEqual(["GLOBAL_SECRET", "DEPLOY_KEY", "NPM_PUBLISH_TOKEN"].toSorted());
    expect(ci.secretNames).not.toContain("ONLY_IN_LINT");
    expect(ci.envNames).toEqual(
      expect.arrayContaining(["DEPLOY_KEY", "NPM_TOKEN", "HARDCODED_TOKEN"]),
    );
    expect(ci.notes.join(" ")).toMatch(/OIDC/);
    expect(report.secrets!.envTemplates).toEqual([
      {
        file: ".env.example",
        names: ["API_SECRET", "PLAIN_SETTING"],
        sensitiveNames: ["API_SECRET"],
      },
    ]);
    expect(report.secrets!.containers[0]).toMatchObject({
      file: "Dockerfile",
      installs: true,
      names: ["NPM_TOKEN"],
      secretMounts: ["npmrc"],
    });
    expect(report.secrets!.npmrc).toEqual([
      { file: ".npmrc", envNames: [], literalCredential: true },
    ]);
    expect(report.secrets!.disclaimer).toMatch(/not a finding that anything was compromised/);

    expect(report.files).toEqual({
      markdown: join(outputDir, "incident-report.md"),
      json: join(outputDir, "incident-report.json"),
    });
    const markdown = readFileSync(report.files!.markdown, "utf8");
    expect(markdown).toContain("- [ ] `NPM_PUBLISH_TOKEN`");
    expect(markdown).toContain("A checklist to review, not a finding");
    expect(JSON.parse(readFileSync(report.files!.json, "utf8"))).toMatchObject({
      schemaVersion: "1.0",
      exposure: { exposed: true },
    });
  });

  it("never lets a secret value reach the report, the markdown or the JSON, and never opens a real .env", async () => {
    buildHistory(repo);
    const outputDir = join(out, "hostile");
    const report = await incident(
      "evil-lib@>=1.0.2",
      { cwd: repo.dir, offline: true, plan: true, outputDir },
      deps(),
    );

    const everything = [
      JSON.stringify(report),
      renderIncidentMarkdown(report),
      readFileSync(report.files!.markdown, "utf8"),
      readFileSync(report.files!.json, "utf8"),
    ].join("\n");
    for (const value of SECRET_VALUES) expect(everything).not.toContain(value);
    // The names are there; the real .env, which is never opened, is not.
    expect(everything).toContain("API_SECRET");
    expect(everything).not.toContain("REAL_SECRET");
    // The plan and run files hold no values either.
    const runDir = join(repo.dir, ".autoremediator");
    expect(existsSync(runDir)).toBe(true);
    const runFiles = repo
      .git("ls-files", "--others", "--ignored", "--exclude-standard")
      .split("\n");
    for (const file of runFiles.filter((entry) => entry.startsWith(".autoremediator/"))) {
      for (const value of SECRET_VALUES)
        expect(readFileSync(join(repo.dir, file), "utf8")).not.toContain(value);
    }
  });

  it("cannot be turned into markdown or shell injection by names in lockfiles, refs or commit data", async () => {
    repo.write("package.json", PACKAGE_JSON);
    repo.write(
      "package-lock.json",
      npmLock("1.0.3", {
        "node_modules/mid": {
          version: "1.0.0",
          name: "mid|x\n## INJECTED HEADING\n`rm -rf`",
          dependencies: { "evil-lib": "^1.0.0" },
        },
      }),
    );
    repo.commit("hostile", "2026-01-01T10:00:00Z");
    repo.git("branch", "feat|`pipe`");
    const report = await incident("evil-lib@1.0.3", { cwd: repo.dir, offline: true }, deps());
    const markdown = renderIncidentMarkdown(report);
    expect(markdown).not.toMatch(/^## INJECTED/m);
    expect(markdown).not.toMatch(/^`rm -rf`/m);
    expect(markdown).toContain(String.raw`feat\|'pipe'`);
  });

  it("defaults are real: the default deps read the registry and inventory through the SDK, not a stub", () => {
    expect(typeof defaultIncidentDeps.fetchPackument).toBe("function");
    expect(typeof defaultIncidentDeps.installed).toBe("function");
  });
});
