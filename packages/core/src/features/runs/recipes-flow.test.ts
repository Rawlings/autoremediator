/**
 * Recipes in the repair flow: real git, real worktrees, real verifier, real promotion, the real
 * recipe files on disk. Replaced: the package manager (package.json is the "install"), the
 * project's type check, and the model (a scripted agent through the `RepairAgent` port).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyRecipe, captureRecipe, listRecipes } from "../recipes/index.js";
import { recipeSchema, recipeId, serializeRecipe, type Recipe } from "../recipes/schema.js";
import type { PatchResult, RemediationReport } from "../remediate/types.js";
import { defaultAttemptDeps, runRepairAttempt } from "../repair/attempt.js";
import type { RepairAgent, RepairOutcome } from "../repair/repair-agent.js";
import { verify } from "../verify/verifier.js";
import { finalizeAttempt, startAttempt } from "./attempts.js";
import { applyPlan, getRun, persistPlan, rollbackRun, type RunDeps } from "./index.js";
import { RunStore } from "./run-store.js";
import { createWorktree } from "./worktree.js";

vi.mock("../remediate/tools/check-inventory.js", () => ({
  checkInventoryTool: {
    execute: vi.fn(async ({ cwd }: { cwd: string }) => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      return {
        packages: Object.entries(manifest.dependencies).map(([name, version]) => ({
          name,
          version,
          type: "direct" as const,
        })),
      };
    }),
  },
}));
vi.mock("../verify/command-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../verify/command-check.js")>()),
  runCommandCheck: vi.fn(async (_command: string[], cwd: string) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    return readFileSync(join(cwd, "src/a.ts"), "utf8").includes("f(1);")
      ? { passed: true, output: "" }
      : {
          passed: false,
          output: "src/a.ts(2,1): error TS2554: Expected 0-1 arguments, but got 2.",
        };
  }),
}));

let dir: string;
let cache: string;
const roots: string[] = [];
const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const setDep = (root: string, version: string) =>
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "app", dependencies: { dep: version } }, null, 2),
  );

/** A project that breaks on dep 2.0.0 until `f(1, 2)` becomes `f(1)`. */
function makeProject(source = "import { f } from 'dep';\nf(1, 2);\n"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "recipes-flow-")));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.test");
  git(root, "config", "user.name", "t");
  setDep(root, "1.0.0");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".github"));
  writeFileSync(join(root, "src/a.ts"), source);
  writeFileSync(join(root, "package-lock.json"), "{}");
  writeFileSync(join(root, "tsconfig.json"), "{}");
  writeFileSync(join(root, ".github/autoremediator.yml"), "allowMajorBumps: true\n");
  writeFileSync(join(root, ".gitignore"), ".autoremediator\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "recipes-flow-cache-"));
  vi.stubEnv("XDG_CACHE_HOME", cache);
  vi.stubEnv("AUTOREMEDIATOR_MODEL", "");
  dir = makeProject();
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

const preview: RemediationReport = {
  cveId: "CVE-2021-0001",
  cveDetails: {
    id: "CVE-2021-0001",
    summary: "",
    severity: "HIGH",
    references: [],
    affectedPackages: [
      {
        name: "dep",
        ecosystem: "npm",
        vulnerableRange: "<2.0.0",
        firstPatchedVersion: "2.0.0",
        source: "osv",
      },
    ],
  },
  vulnerablePackages: [],
  summary: "preview",
  results: [
    {
      packageName: "dep",
      strategy: "version-bump",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      applied: false,
      dryRun: true,
      message: "planned",
      dependencyScope: "direct",
    },
  ],
};
const plan = (root = dir) => persistPlan(preview, { typecheck: true, runTests: true }, root);

const upgraded = (): PatchResult => ({
  packageName: "dep",
  strategy: "version-bump",
  fromVersion: "1.0.0",
  toVersion: "2.0.0",
  applied: true,
  dryRun: false,
  message: "applied",
});
const breaksTheProject: RunDeps["applyItem"] = async () => ({
  packageName: "dep",
  strategy: "version-bump",
  fromVersion: "1.0.0",
  toVersion: "2.0.0",
  applied: false,
  dryRun: false,
  unresolvedReason: "validation-failed",
  message: "npm test failed after upgrading dep to 2.0.0. Rolled back.",
});

const deps = (): RunDeps => ({
  applyItem: breaksTheProject,
  reinstall: vi.fn(async () => undefined),
  verify: (request) => verify(request),
  attempt: (request) =>
    runRepairAttempt(request, {
      ...defaultAttemptDeps,
      createWorktree: (cwd, name) => createWorktree(cwd, name, { XDG_CACHE_HOME: cache }),
      applyUpgrade: async (_item, checkout) => {
        setDep(checkout, "2.0.0");
        return upgraded();
      },
    }),
  attemptDeps: {
    ...defaultAttemptDeps,
    createWorktree: (cwd, name) => createWorktree(cwd, name, { XDG_CACHE_HOME: cache }),
    applyUpgrade: async (_item, checkout) => {
      setDep(checkout, "2.0.0");
      return upgraded();
    },
  },
});

const agentThat = (
  repair: (worktree: string) => RepairOutcome,
): RepairAgent & { calls: number } => {
  const agent = {
    id: "scripted",
    calls: 0,
    async repair(_task: unknown, env: { worktree: string }) {
      agent.calls += 1;
      return repair(env.worktree);
    },
  };
  return agent as RepairAgent & { calls: number };
};
const submitted = (): RepairOutcome => ({
  status: "submitted",
  rationale: "dropped the removed argument",
  usage: [{ purpose: "upgrade-repair", model: "m", inputTokens: 500, outputTokens: 60 }],
  transcript: [{ step: 1, text: "editFile(...)" }],
});
const fix = (worktree: string) =>
  writeFileSync(join(worktree, "src/a.ts"), "import { f } from 'dep';\nf(1);\n");

const fixRecipe: Recipe = recipeSchema.parse({
  schemaVersion: 1,
  package: "dep",
  fromRange: ">=1.0.0 <2.0.0",
  toRange: ">=2.0.0 <3.0.0",
  summary: "f lost its second argument",
  hunks: [
    { before: ["import { f } from 'dep';"], remove: ["f(1, 2);"], add: ["f(1);"], after: [] },
  ],
});
const putRecipe = (root: string, recipe: Recipe, name = "x.json") => {
  const file = join(root, ".autoremediator/recipes/dep", name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeRecipe(recipe));
};
const attemptDir = (root: string, runId: string, attemptId: string) =>
  join(new RunStore(root).runDir(runId), "attempts", attemptId);

describe("recipes in applyPlan", { timeout: 60_000 }, () => {
  it("fixes the project from a committed recipe with no model and no agent", async () => {
    putRecipe(dir, fixRecipe);
    const { runId } = await plan();

    const outcome = await applyPlan({ cwd: dir, runId }, deps());

    expect(outcome.status).toBe("applied");
    expect(outcome.items[0]).toMatchObject({
      status: "applied",
      repair: { status: "promoted", rounds: 0 },
    });
    expect(outcome.items[0]?.message).toMatch(
      /repaired the project with a recipe: recipe dep#[0-9a-f]{10} made the project work \(src\/a\.ts\); no model was asked/,
    );
    expect(read(dir, "package.json")).toContain('"dep": "2.0.0"');
    expect(read(dir, "src/a.ts")).toBe("import { f } from 'dep';\nf(1);\n");

    const details = getRun({ cwd: dir, runId });
    const [attempt] = details.attempts;
    expect(attempt).toMatchObject({
      status: "promoted",
      agentId: `recipe:${recipeId(fixRecipe)}`,
      rounds: 0,
    });
    expect(attempt?.inputTokens).toBeUndefined();
    const dirOfAttempt = attemptDir(dir, runId, attempt!.attemptId);
    expect(readFileSync(join(dirOfAttempt, "transcript.jsonl"), "utf8")).toMatch(
      /the verifier accepted it/,
    );
    expect(readFileSync(join(dirOfAttempt, "diff.patch"), "utf8")).toContain("+f(1);");
    // A recipe's own fix is not captured again.
    expect(existsSync(join(dirOfAttempt, "recipe.json"))).toBe(false);
    expect(details.ledger.ok).toBe(true);
    expect(git(dir, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("tries the recipe before the agent: a model is not asked when a recipe works", async () => {
    putRecipe(dir, fixRecipe);
    const agent = agentThat(() => submitted());
    const { runId } = await plan();
    const outcome = await applyPlan({ cwd: dir, runId, repairAgent: agent }, deps());
    expect(outcome.status).toBe("applied");
    expect(agent.calls).toBe(0);
  });

  it("takes a recipe the verifier rejects back out and hands over to the agent from the checkout as it was", async () => {
    const wrong = recipeSchema.parse({
      ...fixRecipe,
      hunks: [{ ...fixRecipe.hunks[0]!, add: ["f(1, 3);"] }],
    });
    putRecipe(dir, wrong);
    let seen = "";
    const agent = agentThat((worktree) => {
      seen = readFileSync(join(worktree, "src/a.ts"), "utf8");
      fix(worktree);
      return submitted();
    });
    const { runId } = await plan();

    const outcome = await applyPlan({ cwd: dir, runId, repairAgent: agent }, deps());

    expect(outcome.items[0]).toMatchObject({ status: "applied", repair: { status: "promoted" } });
    expect(agent.calls).toBe(1);
    expect(seen).toBe("import { f } from 'dep';\nf(1, 2);\n"); // the recipe was undone before the agent looked
    const [attempt] = getRun({ cwd: dir, runId }).attempts;
    expect(attempt?.agentId).toBe("scripted");
    const transcript = readFileSync(
      join(attemptDir(dir, runId, attempt!.attemptId), "transcript.jsonl"),
      "utf8",
    );
    expect(transcript).toMatch(/the verifier rejected it \(typecheck\); undone/);
  });

  it("does not apply a recipe whose context has drifted, and without an agent the item stays failed and the project untouched", async () => {
    putRecipe(
      dir,
      recipeSchema.parse({
        ...fixRecipe,
        hunks: [{ ...fixRecipe.hunks[0]!, remove: ["f(1,2);"] }],
      }),
    );
    const { runId } = await plan();

    const outcome = await applyPlan({ cwd: dir, runId }, deps());

    expect(outcome.items[0]).toMatchObject({ status: "failed", repair: { status: "rejected" } });
    expect(outcome.items[0]?.message).toMatch(
      /no recipe made the project work \(1 tried\) and no repair agent is configured/,
    );
    expect(read(dir, "package.json")).toContain('"dep": "1.0.0"');
    expect(read(dir, "src/a.ts")).toBe("import { f } from 'dep';\nf(1, 2);\n");
    expect(git(dir, "status", "--porcelain").trim()).toBe("");
    const [attempt] = getRun({ cwd: dir, runId }).attempts;
    expect(
      readFileSync(join(attemptDir(dir, runId, attempt!.attemptId), "transcript.jsonl"), "utf8"),
    ).toMatch(/not applied: hunk 1 .* does not match any source file exactly/);
  });

  it("does nothing, and creates no checkout, when no recipe is for this upgrade and no model is configured", async () => {
    putRecipe(dir, recipeSchema.parse({ ...fixRecipe, fromRange: ">=5.0.0 <6.0.0" }));
    const { runId } = await plan();
    const outcome = await applyPlan({ cwd: dir, runId }, deps());
    expect(outcome.items[0]?.repair).toBeUndefined();
    expect(getRun({ cwd: dir, runId }).attempts).toEqual([]);
  });

  it("never uses recipes when repair is turned off", async () => {
    putRecipe(dir, fixRecipe);
    const { runId } = await plan();
    const outcome = await applyPlan({ cwd: dir, runId, repair: false }, deps());
    expect(outcome.items[0]?.repair).toBeUndefined();
    expect(read(dir, "src/a.ts")).toBe("import { f } from 'dep';\nf(1, 2);\n");
  });

  it("reads a policy recipes package, and ignores recipes a dependency ships for itself", async () => {
    // A dependency can ship a recipe; it is not read unless the policy names the package.
    const shipped = (root: string, name: string, recipe: Recipe) => {
      const file = join(root, "node_modules", name, "autoremediator-recipes", "r.json");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, serializeRecipe(recipe));
    };
    // A policy package installed in the project (a real checkout installs it too); the project commits its policy.
    mkdirSync(join(dir, "node_modules/@acme/recipes/recipes/dep"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules/@acme/recipes/recipes/dep/r.json"),
      serializeRecipe(fixRecipe),
    );
    writeFileSync(
      join(dir, ".github/autoremediator.yml"),
      'allowMajorBumps: true\nrecipes:\n  packages:\n    - "@acme/recipes"\n',
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "policy");
    expect(listRecipes({ cwd: dir }).recipes.map((entry) => entry.source)).toEqual([
      { kind: "policy-package", package: "@acme/recipes" },
    ]);

    const { runId } = await plan();
    const outcome = await applyPlan({ cwd: dir, runId }, deps());
    expect(outcome.items[0]).toMatchObject({ status: "applied", repair: { status: "promoted" } });
    expect(getRun({ cwd: dir, runId }).attempts[0]?.agentId).toMatch(/^recipe:dep#/);

    // Neither the package being upgraded nor any other dependency is a source by shipping one.
    const stranger = makeProject();
    shipped(stranger, "dep", fixRecipe);
    shipped(stranger, "evil-dep", fixRecipe);
    expect(listRecipes({ cwd: stranger })).toMatchObject({ recipes: [], problems: [] });
  });
});

describe("learning once and reusing it", { timeout: 60_000 }, () => {
  it("captures what an agent did, saves it, and a second project then needs no agent", async () => {
    // Project one: an agent fixes it.
    const agent = agentThat((worktree) => {
      fix(worktree);
      return submitted();
    });
    const { runId } = await plan();
    const first = await applyPlan({ cwd: dir, runId, repairAgent: agent }, deps());
    expect(first.items[0]).toMatchObject({ status: "applied", repair: { status: "promoted" } });
    expect(agent.calls).toBe(1);

    const attempt = getRun({ cwd: dir, runId }).attempts[0]!;
    const derived = JSON.parse(
      readFileSync(join(attemptDir(dir, runId, attempt.attemptId), "recipe.json"), "utf8"),
    ) as Recipe;
    expect(derived).toMatchObject({
      package: "dep",
      fromRange: ">=1.0.0 <2.0.0",
      toRange: ">=2.0.0 <3.0.0",
      observed: { fromVersion: "1.0.0", toVersion: "2.0.0" },
      summary: "dropped the removed argument",
      hunks: [
        { before: ["import { f } from 'dep';"], remove: ["f(1, 2);"], add: ["f(1);"], after: [] },
      ],
      evidence: { runId, attemptId: attempt.attemptId, agent: "scripted" },
    });
    // What broke came from the verifier's findings; the evidence is the checks that passed.
    expect(derived.breaking[0]).toMatchObject({
      kind: "diagnostic-TS2554",
      message: expect.stringContaining("Expected 0-1 arguments"),
    });
    expect(derived.evidence?.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining(["scope", "typecheck"]),
    );
    expect(
      derived.evidence?.checks.every(
        (check) => check.status === "passed" || check.status === "skipped",
      ),
    ).toBe(true);
    expect(getRun({ cwd: dir, runId }).ledger.events.map((event) => event.type)).toContain(
      "recipe.captured",
    );

    // Capture it into the project's committed directory (idempotently).
    const saved = captureRecipe({ cwd: dir, runId });
    expect(saved).toMatchObject({ created: true });
    expect(saved.path).toBe(join(dir, ".autoremediator/recipes/dep/1.0.0-to-2.0.0.json"));
    expect(captureRecipe({ cwd: dir, runId }).created).toBe(false);
    expect(
      listRecipes({ cwd: dir, packageName: "dep", fromVersion: "1.0.0", toVersion: "2.0.0" })
        .recipes,
    ).toMatchObject([{ id: saved.id, applies: true, hunks: 1 }]);
    expect(listRecipes({ cwd: dir, recipeId: saved.id }).recipes[0]?.recipe?.hunks).toHaveLength(1);

    // Project two has the same code and never sees the agent.
    const second = makeProject();
    writeFileSync(join(second, ".gitignore"), ".autoremediator\n");
    mkdirSync(join(second, ".autoremediator/recipes/dep"), { recursive: true });
    writeFileSync(
      join(second, ".autoremediator/recipes/dep/shared.json"),
      readFileSync(saved.path),
    );
    const secondRun = await plan(second);
    const lonely = agentThat(() => submitted());
    const reuse = await applyPlan(
      { cwd: second, runId: secondRun.runId, repairAgent: lonely },
      deps(),
    );
    expect(reuse.status).toBe("applied");
    expect(lonely.calls).toBe(0);
    expect(read(second, "src/a.ts")).toBe("import { f } from 'dep';\nf(1);\n");
    expect(getRun({ cwd: second, runId: secondRun.runId }).attempts[0]?.agentId).toBe(
      `recipe:${saved.id}`,
    );

    // And the whole thing can still be rolled back.
    await rollbackRun({ cwd: second, runId: secondRun.runId }, deps());
    expect(read(second, "src/a.ts")).toBe("import { f } from 'dep';\nf(1, 2);\n");
    expect(git(second, "status", "--porcelain").trim()).toBe("");
  });

  it("refuses to capture a run with no agent repair, or a named attempt that has no recipe", async () => {
    putRecipe(dir, fixRecipe);
    const { runId } = await plan();
    await applyPlan({ cwd: dir, runId }, deps());
    expect(() => captureRecipe({ cwd: dir, runId })).toThrow(
      /no promoted agent repair with a recipe/,
    );
    expect(() => captureRecipe({ cwd: dir, runId, attemptId: "attempt_aaaaaaaaaaaa" })).toThrow(
      /no recipe to capture/,
    );
  });

  it("applies the recipe only where its context matches: a project with different code is left alone", async () => {
    const other = makeProject("import { f } from 'dep';\nf(1, 2, 3);\n");
    putRecipe(other, fixRecipe);
    const { runId } = await plan(other);
    const outcome = await applyPlan({ cwd: other, runId }, deps());
    expect(outcome.items[0]).toMatchObject({ status: "failed" });
    expect(read(other, "src/a.ts")).toBe("import { f } from 'dep';\nf(1, 2, 3);\n");
    const worktrees = join(cache, "autoremediator", "worktrees");
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
  });
});

describe("recipes for a host agent's attempt", { timeout: 60_000 }, () => {
  it("suggests recipes at startAttempt, applies one under the same validation and verifier, and finalizes it", async () => {
    putRecipe(dir, fixRecipe);
    const { runId } = await plan();
    const [item] = getRun({ cwd: dir, runId }).plan!.items;

    const started = await startAttempt({ cwd: dir, runId, itemId: item!.itemId }, deps());
    expect(started.verification?.passed).toBe(false);
    expect(started.recipes).toEqual([
      { id: recipeId(fixRecipe), source: "project", summary: "f lost its second argument" },
    ]);

    const applied = await applyRecipe(
      { cwd: dir, runId, attemptId: started.attemptId, recipeId: recipeId(fixRecipe) },
      deps(),
    );
    expect(applied.recipe).toEqual({ id: recipeId(fixRecipe), applied: true, files: ["src/a.ts"] });
    expect(applied.verification?.passed).toBe(true);
    expect(read(started.worktreePath!, "src/a.ts")).toBe("import { f } from 'dep';\nf(1);\n");

    const done = await finalizeAttempt({ cwd: dir, runId, attemptId: started.attemptId }, deps());
    expect(done.finalized).toBe(true);
    expect(read(dir, "src/a.ts")).toBe("import { f } from 'dep';\nf(1);\n");
    expect(getRun({ cwd: dir, runId }).ledger.events.map((event) => event.type)).toContain(
      "attempt.recipe",
    );
  });

  it("undoes a recipe the verifier rejects, and refuses recipes that are for another upgrade or do not match", async () => {
    const wrong = recipeSchema.parse({
      ...fixRecipe,
      hunks: [{ ...fixRecipe.hunks[0]!, add: ["f(1, 3);"] }],
    });
    const drifted = recipeSchema.parse({
      ...fixRecipe,
      hunks: [{ ...fixRecipe.hunks[0]!, remove: ["f(1,2);"] }],
    });
    const elsewhere = recipeSchema.parse({ ...fixRecipe, toRange: ">=9.0.0" });
    putRecipe(dir, wrong, "wrong.json");
    putRecipe(dir, drifted, "drifted.json");
    putRecipe(dir, elsewhere, "elsewhere.json");
    const { runId } = await plan();
    const [item] = getRun({ cwd: dir, runId }).plan!.items;
    const started = await startAttempt({ cwd: dir, runId, itemId: item!.itemId }, deps());
    expect(started.recipes?.map((entry) => entry.id).toSorted()).toEqual(
      [recipeId(wrong), recipeId(drifted)].toSorted(),
    );

    const rejected = await applyRecipe(
      { cwd: dir, runId, attemptId: started.attemptId, recipeId: recipeId(wrong) },
      deps(),
    );
    expect(rejected.recipe).toMatchObject({ applied: false, rejectedBy: "typecheck" });
    expect(rejected.message).toMatch(/undone; the checkout is as it was/);
    expect(read(started.worktreePath!, "src/a.ts")).toBe("import { f } from 'dep';\nf(1, 2);\n");

    await expect(
      applyRecipe(
        { cwd: dir, runId, attemptId: started.attemptId, recipeId: recipeId(drifted) },
        deps(),
      ),
    ).rejects.toThrow(/does not apply: hunk 1/);
    await expect(
      applyRecipe(
        { cwd: dir, runId, attemptId: started.attemptId, recipeId: recipeId(elsewhere) },
        deps(),
      ),
    ).rejects.toThrow(/not for dep 1\.0\.0 to 2\.0\.0/);
    await expect(
      applyRecipe(
        { cwd: dir, runId, attemptId: started.attemptId, recipeId: "dep#0000000000" },
        deps(),
      ),
    ).rejects.toThrow(/Recipe not found/);
  });
});
