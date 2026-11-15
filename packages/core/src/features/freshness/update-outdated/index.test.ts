import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocked = vi.hoisted(() => ({
  queryOutdatedPackages: vi.fn(),
  loadPolicy: vi.fn(),
  createEvidenceLog: vi.fn(),
  addEvidenceStep: vi.fn(),
  finalizeEvidence: vi.fn(),
  writeEvidenceLog: vi.fn(),
  detectPackageManager: vi.fn(),
  getYarnMajorVersion: vi.fn(),
  resolveInstallCommand: vi.fn(),
  resolveTestCommand: vi.fn(),
  withRepoLock: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  execa: vi.fn(),
  loadMemoryConstraints: vi.fn(),
}));

vi.mock("../../memory/consume.js", () => ({
  loadMemoryConstraints: mocked.loadMemoryConstraints,
}));

vi.mock("../../intelligence/sources/registry.js", () => ({
  queryOutdatedPackages: mocked.queryOutdatedPackages,
}));

vi.mock("../../../infra/policy/policy.js", () => ({
  loadPolicy: mocked.loadPolicy,
}));

vi.mock("../../evidence/log.js", () => ({
  createEvidenceLog: mocked.createEvidenceLog,
  addEvidenceStep: mocked.addEvidenceStep,
  finalizeEvidence: mocked.finalizeEvidence,
  writeEvidenceLog: mocked.writeEvidenceLog,
}));

vi.mock("../../../infra/package-manager/index.js", () => ({
  detectPackageManager: mocked.detectPackageManager,
  getYarnMajorVersion: mocked.getYarnMajorVersion,
  resolveInstallCommand: mocked.resolveInstallCommand,
  resolveTestCommand: mocked.resolveTestCommand,
}));

vi.mock("../../../infra/repo-lock.js", () => ({
  withRepoLock: mocked.withRepoLock,
}));

vi.mock("../../memory/test-command.js", () => ({
  resolveProjectTestCommand: (...args: unknown[]) => mocked.resolveTestCommand(...args),
}));

vi.mock("node:fs", () => ({
  readFileSync: mocked.readFileSync,
  writeFileSync: mocked.writeFileSync,
}));

vi.mock("execa", () => ({
  execa: mocked.execa,
}));

import { updateOutdated } from "./index.js";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const cwd = "/tmp/test-project";

const baseOutdatedMap = new Map([
  [
    "lodash",
    {
      currentVersion: "4.17.19",
      wantedVersion: "4.17.21",
      latestVersion: "4.17.21",
      isMajorBump: false,
      dependencyScope: "direct" as const,
    },
  ],
  [
    "minimist",
    {
      currentVersion: "1.2.5",
      wantedVersion: "1.2.8",
      latestVersion: "1.2.8",
      isMajorBump: false,
      dependencyScope: "direct" as const,
    },
  ],
]);

const basePolicy = {
  allowMajorBumps: false,
  denyPackages: [],
  allowPackages: [],
  constraints: {},
};

const baseEvidence = {
  runId: "run-1",
  cveIds: [],
  cwd,
  startedAt: new Date().toISOString(),
  steps: [],
};

function makePkgJson(overrides: Record<string, string> = {}) {
  return JSON.stringify({
    dependencies: {
      lodash: "^4.17.19",
      minimist: "^1.2.5",
      ...overrides,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  mocked.loadPolicy.mockReturnValue(basePolicy);
  mocked.createEvidenceLog.mockReturnValue({ ...baseEvidence });
  mocked.writeEvidenceLog.mockReturnValue(`${cwd}/.autoremediator/evidence/run-1.json`);
  mocked.detectPackageManager.mockReturnValue("npm");
  mocked.resolveInstallCommand.mockReturnValue(["npm", "ci"]);
  mocked.resolveTestCommand.mockReturnValue(["npm", "test"]);
  mocked.readFileSync.mockReturnValue(makePkgJson());
  mocked.execa.mockResolvedValue({ exitCode: 0 });
  mocked.loadMemoryConstraints.mockReturnValue({ pinned: new Map(), rejected: new Map() });
  mocked.withRepoLock.mockImplementation((_cwd: string, fn: () => Promise<unknown>) => fn());
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("updateOutdated", () => {
  it("returns ok report when all packages are bumped successfully", async () => {
    mocked.queryOutdatedPackages.mockResolvedValue(baseOutdatedMap);

    const report = await updateOutdated({ cwd });

    expect(report.schemaVersion).toBe("1.0");
    expect(report.status).toBe("ok");
    expect(report.outdatedPackages).toHaveLength(2);
    expect(report.successCount).toBe(2);
    expect(report.failedCount).toBe(0);
    expect(report.skippedCount).toBe(0);
    expect(report.errors).toHaveLength(0);
    expect(report.patchCount).toBe(0);
    expect(report.evidenceFile).toBeDefined();
  });

  it("leaves a package that memory pins alone, unless memory is ignored", async () => {
    mocked.queryOutdatedPackages.mockResolvedValue(baseOutdatedMap);
    mocked.loadMemoryConstraints.mockReturnValue({
      pinned: new Map([
        [
          "lodash",
          {
            kind: "pinned-package",
            id: "mem_0123456789",
            package: "lodash",
            reason: "v5 drops a method we use",
          },
        ],
      ]),
      rejected: new Map(),
    });

    const report = await updateOutdated({ cwd, dryRun: true });
    expect(report.successCount).toBe(1);
    expect(report.skippedCount).toBe(1);
    expect(mocked.addEvidenceStep).toHaveBeenCalledWith(
      expect.anything(),
      "update-outdated.skip",
      expect.objectContaining({
        packageName: "lodash",
        reason: "pinned-by-memory",
        entry: "mem_0123456789",
      }),
      {},
    );

    const ignored = await updateOutdated({ cwd, dryRun: true, ignoreMemory: true });
    expect(ignored.successCount).toBe(2);
    expect(ignored.skippedCount).toBe(0);
  });

  it("respects dryRun: does not mutate files when dryRun is true", async () => {
    mocked.queryOutdatedPackages.mockResolvedValue(baseOutdatedMap);

    const report = await updateOutdated({ cwd, dryRun: true });

    expect(report.status).toBe("ok");
    expect(report.successCount).toBe(2);
    expect(mocked.writeFileSync).not.toHaveBeenCalled();
    expect(mocked.execa).not.toHaveBeenCalled();
  });

  it("skips major bumps when allowMajorBumps is false (default)", async () => {
    const mapWithMajor = new Map([
      [
        "lodash",
        {
          currentVersion: "4.17.19",
          wantedVersion: "4.17.21",
          latestVersion: "4.17.21",
          isMajorBump: false,
          dependencyScope: "direct" as const,
        },
      ],
      [
        "chalk",
        {
          currentVersion: "4.1.2",
          wantedVersion: "4.1.2",
          latestVersion: "5.3.0",
          isMajorBump: true,
          dependencyScope: "direct" as const,
        },
      ],
    ]);

    mocked.queryOutdatedPackages.mockResolvedValue(mapWithMajor);
    mocked.loadPolicy.mockReturnValue({ ...basePolicy, allowMajorBumps: false });

    const report = await updateOutdated({ cwd });

    expect(report.successCount).toBe(1);
    expect(report.skippedCount).toBe(1);
    expect(report.failedCount).toBe(0);
    // chalk should be in outdatedPackages but skipped
    const chalkEntry = report.outdatedPackages.find((p) => p.name === "chalk");
    expect(chalkEntry).toBeDefined();
    expect(chalkEntry?.isMajorBump).toBe(true);
  });

  it("includes transitive packages when includeTransitive is true", async () => {
    const mapWithTransitive = new Map([
      [
        "lodash",
        {
          currentVersion: "4.17.19",
          wantedVersion: "4.17.21",
          latestVersion: "4.17.21",
          isMajorBump: false,
          dependencyScope: "direct" as const,
        },
      ],
      [
        "supports-color",
        {
          currentVersion: "8.1.1",
          wantedVersion: "8.1.1",
          latestVersion: "9.4.0",
          isMajorBump: true,
          dependencyScope: "transitive" as const,
        },
      ],
    ]);

    mocked.queryOutdatedPackages.mockResolvedValue(mapWithTransitive);

    const report = await updateOutdated({ cwd, includeTransitive: true, dryRun: true });

    // queryOutdatedPackages was called with includeTransitive: true
    expect(mocked.queryOutdatedPackages).toHaveBeenCalledWith(
      cwd,
      expect.objectContaining({ includeTransitive: true }),
    );
    expect(report.outdatedPackages).toHaveLength(2);
    const transitivePkg = report.outdatedPackages.find((p) => p.name === "supports-color");
    expect(transitivePkg?.dependencyScope).toBe("transitive");
  });

  it("returns failed status when registry query throws", async () => {
    mocked.queryOutdatedPackages.mockRejectedValue(new Error("npm registry unavailable"));

    const report = await updateOutdated({ cwd });

    expect(report.status).toBe("failed");
    expect(report.successCount).toBe(0);
    expect(report.failedCount).toBe(1);
    expect(report.errors[0]?.packageName).toBe("*");
    expect(report.errors[0]?.message).toContain("npm registry unavailable");
    expect(report.outdatedPackages).toHaveLength(0);
  });
});
