/** The recipe format, matcher, discovery, capture and export. Real git and real files; no network. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureRecipe, rangeAround } from "./capture.js";
import { discoverRecipes, recipesFor } from "./discover.js";
import { appliesTo, planRecipe, type SourceFile } from "./engine.js";
import { parseRecipe, recipeId, recipeSchema, serializeRecipe, type Recipe } from "./schema.js";
import { exportRecipePackage, saveProjectRecipe } from "./store.js";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const write = (file: string, text: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "recipes-")));
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = {
  schemaVersion: 1,
  package: "dep",
  fromRange: ">=1.0.0 <2.0.0",
  toRange: ">=2.0.0 <3.0.0",
} as const;

const dropArgument: Recipe = recipeSchema.parse({
  ...base,
  summary: "f no longer takes a second argument",
  hunks: [{ before: ["import { f } from 'dep';"], remove: ["f(1, 2);"], add: ["f(1);"], after: [] }],
});

const files = (...entries: [string, string][]): SourceFile[] => entries.map(([path, text]) => ({ path, text }));

/** Check that `git apply` accepts a plan's diff against these files, and return what they become. */
function applyWithGit(entries: [string, string][], diff: string): Record<string, string> {
  for (const [path, text] of entries) write(path, text);
  git("add", "-A");
  git("commit", "-q", "-m", "x");
  execFileSync("git", ["apply", "--check", "-"], { cwd: dir, input: diff });
  execFileSync("git", ["apply", "-"], { cwd: dir, input: diff });
  return Object.fromEntries(entries.map(([path]) => [path, readFileSync(join(dir, path), "utf8")]));
}

describe("the recipe schema", () => {
  it("accepts a well-formed recipe and gives it a stable content id", () => {
    const again = parseRecipe(serializeRecipe(dropArgument));
    expect(recipeId(again)).toBe(recipeId(dropArgument));
    expect(recipeId(dropArgument)).toMatch(/^dep#[0-9a-f]{10}$/);
    // Who captured it and what it says about itself are not part of what it does.
    expect(recipeId({ ...dropArgument, summary: "other words", evidence: { checks: [] } })).toBe(recipeId(dropArgument));
    expect(recipeId({ ...dropArgument, hunks: [{ ...dropArgument.hunks[0]!, add: ["f(1, 3);"] }] })).not.toBe(recipeId(dropArgument));
  });

  it.each([
    ["an unknown field", { ...dropArgument, run: "rm -rf /" }],
    ["a package name that climbs out of its directory", { ...dropArgument, package: "../../etc" }],
    ["an absolute package name", { ...dropArgument, package: "/etc/passwd" }],
    ["a bad range", { ...dropArgument, fromRange: "not a range" }],
    ["a line break inside a line", { ...dropArgument, hunks: [{ ...dropArgument.hunks[0]!, add: ["f(1);\n+++ b/package.json"] }] }],
    ["a NUL", { ...dropArgument, hunks: [{ ...dropArgument.hunks[0]!, add: ["f(1);\0"] }] }],
    ["no hunks", { ...dropArgument, hunks: [] }],
    ["a hunk that changes nothing", { ...dropArgument, hunks: [{ before: ["x"], remove: ["a"], add: ["a"], after: [] }] }],
    ["a hunk anchored only by blank lines", { ...dropArgument, hunks: [{ before: [""], remove: [], add: ["x"], after: ["  "] }] }],
    ["a hunk with an unknown field", { ...dropArgument, hunks: [{ ...dropArgument.hunks[0]!, file: "../../x" }] }],
    ["a wrong schema version", { ...dropArgument, schemaVersion: 2 }],
  ])("rejects %s", (_name, recipe) => {
    expect(() => parseRecipe(JSON.stringify(recipe))).toThrow(/invalid recipe/);
  });

  it("rejects text that is not JSON, and oversize files", () => {
    expect(() => parseRecipe("{nope")).toThrow(/not valid JSON/);
    expect(() => parseRecipe(" ".repeat(600_000))).toThrow(/larger than/);
  });
});

describe("matching versions", () => {
  it("applies when both versions fall in the ranges", () => {
    expect(appliesTo(dropArgument, "1.4.0", "2.0.0")).toBe(true);
    expect(appliesTo(dropArgument, "1.4.0", "2.9.9")).toBe(true);
    expect(appliesTo(dropArgument, "0.9.0", "2.0.0")).toBe(false);
    expect(appliesTo(dropArgument, "1.4.0", "3.0.0")).toBe(false);
    expect(appliesTo(dropArgument, "1.4.0", "2.0.0-beta.1")).toBe(false);
    expect(appliesTo(dropArgument, "garbage", "2.0.0")).toBe(false);
  });

  it("derives a range around an observed version", () => {
    expect(rangeAround("1.2.3")).toBe(">=1.2.3 <2.0.0");
    expect(rangeAround("0.3.1")).toBe(">=0.3.1 <0.4.0");
    expect(rangeAround("latest")).toBeUndefined();
  });
});

describe("applying a recipe", () => {
  const source = "import { f } from 'dep';\nconst a = 1;\nf(1, 2);\nconst b = 2;\n";

  it("matches exactly, produces a diff git accepts, and changes only the matched lines", () => {
    const plan = planRecipe(dropArgument, files(["src/a.ts", source]));
    expect(plan).toMatchObject({ ok: false }); // `before` is the import, but `f(1, 2)` is not right after it
    const adjacent = "import { f } from 'dep';\nf(1, 2);\nconst b = 2;\n";
    const ok = planRecipe(dropArgument, files(["src/a.ts", adjacent]));
    if (!ok.ok) throw new Error(ok.reason);
    expect(ok.files).toEqual(["src/a.ts"]);
    expect(ok.matches).toEqual([{ hunk: 0, file: "src/a.ts", line: 2 }]);
    expect(applyWithGit([["src/a.ts", adjacent]], ok.diff)["src/a.ts"]).toBe("import { f } from 'dep';\nf(1);\nconst b = 2;\n");
  });

  it("applies everywhere the context matches, across files, with several hunks per file", () => {
    const recipe = recipeSchema.parse({
      ...base,
      hunks: [
        { before: [], remove: ["import dep from 'dep';"], add: ["import { dep } from 'dep';"], after: [] },
        { before: ["// call"], remove: ["dep.old();"], add: ["dep.next();"], after: [] },
      ],
    });
    const long = (n: number) => Array.from({ length: n }, (_, i) => `const filler${i} = ${i};`).join("\n");
    const a = `import dep from 'dep';\n${long(20)}\n// call\ndep.old();\n${long(3)}\n// call\ndep.old();\n`;
    const b = `import dep from 'dep';\n// call\ndep.old();\n`;
    const plan = planRecipe(recipe, files(["src/a.js", a], ["src/b.js", b]));
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.matches).toHaveLength(5);
    const result = applyWithGit([["src/a.js", a], ["src/b.js", b]], plan.diff);
    expect(result["src/a.js"]).toBe(a.replace("import dep from 'dep';", "import { dep } from 'dep';").replaceAll("dep.old();", "dep.next();"));
    expect(result["src/b.js"]).toBe(b.replace("import dep from 'dep';", "import { dep } from 'dep';").replace("dep.old();", "dep.next();"));
  });

  it("handles pure insertions and pure deletions", () => {
    const recipe = recipeSchema.parse({
      ...base,
      hunks: [
        { before: ["import { f } from 'dep';"], remove: [], add: ["import { g } from 'dep';"], after: [] },
        { before: [], remove: ["f.deprecatedSetup();"], add: [], after: ["run();"] },
      ],
    });
    const text = "import { f } from 'dep';\nf.deprecatedSetup();\nrun();\n";
    const plan = planRecipe(recipe, files(["x.ts", text]));
    if (!plan.ok) throw new Error(plan.reason);
    expect(applyWithGit([["x.ts", text]], plan.diff)["x.ts"]).toBe("import { f } from 'dep';\nimport { g } from 'dep';\nrun();\n");
  });

  it("fails closed when the context has drifted: nothing is produced, not even a partial diff", () => {
    for (const drifted of [
      "import { f } from 'dep';\nf(1,2);\n", // whitespace
      "import { f } from 'dep';\n  f(1, 2);\n", // indentation
      "import { f } from \"dep\";\nf(1, 2);\n", // quote style in the context
      "import { f } from 'dep';\nf(1, 2)\n", // semicolon
    ]) {
      const plan = planRecipe(dropArgument, files(["src/a.ts", drifted]));
      expect(plan).toMatchObject({ ok: false });
      if (!plan.ok) expect(plan.reason).toMatch(/does not match any source file exactly/);
    }
  });

  it("does nothing when one required hunk matches and another does not, unless it is optional", () => {
    const recipe = recipeSchema.parse({
      ...base,
      hunks: [
        { before: [], remove: ["a();"], add: ["b();"], after: [] },
        { before: [], remove: ["missing();"], add: ["z();"], after: [] },
      ],
    });
    const text = "import 'dep';\na();\n";
    expect(planRecipe(recipe, files(["x.ts", text]))).toMatchObject({ ok: false });
    const optional = { ...recipe, hunks: [recipe.hunks[0]!, { ...recipe.hunks[1]!, optional: true }] };
    const plan = planRecipe(optional, files(["x.ts", text]));
    expect(plan).toMatchObject({ ok: true, unmatchedOptional: [1] });
  });

  it("only touches files that import the package, and leaves CRLF files and files without a final newline alone", () => {
    const text = "f(1, 2);\n";
    const hunk = recipeSchema.parse({ ...base, hunks: [{ before: [], remove: ["f(1, 2);"], add: ["f(1);"], after: [] }] });
    expect(planRecipe(hunk, files(["unrelated.ts", text]))).toMatchObject({ ok: false });
    expect(planRecipe(hunk, files(["a.ts", `import 'dep';\n${text}`]))).toMatchObject({ ok: true });
    expect(planRecipe(hunk, files(["a.ts", `import 'dep';\r\n${text}`]))).toMatchObject({ ok: false });
    expect(planRecipe(hunk, files(["a.ts", `import 'dep';\n${text.trimEnd()}`]))).toMatchObject({ ok: false });
    // A subpath import counts; a package that merely contains the name does not.
    expect(planRecipe(hunk, files(["a.ts", `import 'dep/sub';\n${text}`]))).toMatchObject({ ok: true });
    expect(planRecipe(hunk, files(["a.ts", `import 'dep-other';\n${text}`]))).toMatchObject({ ok: false });
  });

  it("refuses overlapping hunks", () => {
    const recipe = recipeSchema.parse({
      ...base,
      hunks: [
        { before: [], remove: ["a();", "b();"], add: ["x();"], after: [] },
        { before: [], remove: ["b();", "c();"], add: ["y();"], after: [] },
      ],
    });
    const plan = planRecipe(recipe, files(["a.ts", "import 'dep';\na();\nb();\nc();\n"]));
    expect(plan).toMatchObject({ ok: false, reason: expect.stringMatching(/overlap/) });
  });

  it("never lets content act as diff syntax or reach other files", () => {
    // Lines that look like diff headers, or git's binary/mode/rename markers, are ordinary content here.
    const hostile = recipeSchema.parse({
      ...base,
      hunks: [
        {
          before: [],
          remove: ["f(1, 2);"],
          add: ["f(1); // +++ b/package.json", "--- a/package.json", "diff --git a/.github/workflows/x.yml b/.github/workflows/x.yml", "GIT binary patch", "new file mode 120000"],
          after: [],
        },
      ],
    });
    const plan = planRecipe(hostile, files(["a.ts", "import 'dep';\nf(1, 2);\n"]));
    if (!plan.ok) throw new Error(plan.reason);
    const result = applyWithGit([["a.ts", "import 'dep';\nf(1, 2);\n"]], plan.diff);
    expect(result["a.ts"]).toContain("--- a/package.json\n");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim()).toBe("M a.ts");
  });

  it("ignores source files whose paths could not be written safely into a diff header", () => {
    const hunk = recipeSchema.parse({ ...base, hunks: [{ before: [], remove: ["f(1, 2);"], add: ["f(1);"], after: [] }] });
    for (const path of ["../outside.ts", "a b.ts", "src/../../x.ts", "src/\"x\".ts", "./a.ts"]) {
      expect(planRecipe(hunk, files([path, "import 'dep';\nf(1, 2);\n"]))).toMatchObject({ ok: false });
    }
  });
});

describe("discovering recipes", () => {
  const put = (path: string, recipe: unknown) => write(path, typeof recipe === "string" ? recipe : serializeRecipe(recipe as Recipe));

  it("reads the project's committed recipes, policy recipe packages and the packages' own", () => {
    put(".autoremediator/recipes/dep/1-to-2.json", dropArgument);
    const other = recipeSchema.parse({ ...base, package: "other", hunks: [{ remove: ["o();"], add: ["p();"] }] });
    put("node_modules/@acme/recipes/recipes/other/x.json", other);
    const shipped = recipeSchema.parse({ ...base, package: "shipper", hunks: [{ remove: ["s();"], add: ["t();"] }] });
    put("node_modules/shipper/autoremediator-recipes/a.json", shipped);

    const found = discoverRecipes({ projectDir: dir, installRoot: dir, policyPackages: ["@acme/recipes"] });
    expect(found.problems).toEqual([]);
    expect(found.recipes.map((entry) => [entry.recipe.package, entry.source.kind]).toSorted((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["dep", "project"],
      ["other", "policy-package"],
      ["shipper", "installed"],
    ]);
    expect(recipesFor(found, "dep", "1.1.0", "2.0.0")).toHaveLength(1);
    expect(recipesFor(found, "dep", "1.1.0", "3.0.0")).toHaveLength(0);
  });

  it("lets a package ship recipes only for itself", () => {
    put("node_modules/evil/autoremediator-recipes/a.json", recipeSchema.parse({ ...base, package: "dep", hunks: [{ remove: ["a();"], add: ["b();"] }] }));
    const found = discoverRecipes({ projectDir: dir, installRoot: dir });
    expect(found.recipes).toEqual([]);
    expect(found.problems[0]?.error).toMatch(/may only ship recipes for itself/);
  });

  it("reports an invalid recipe without hiding the valid ones, and never reads outside the directory through a symlink", () => {
    put(".autoremediator/recipes/dep/good.json", dropArgument);
    put(".autoremediator/recipes/dep/bad.json", '{"schemaVersion":1,"package":"dep","hunks":[]}');
    put(".autoremediator/recipes/dep/hostile.json", { ...dropArgument, package: "../../escape" });
    write("secret.json", serializeRecipe(dropArgument));
    symlinkSync(join(dir, "secret.json"), join(dir, ".autoremediator/recipes/dep/link.json"));
    symlinkSync(dir, join(dir, ".autoremediator/recipes/dep/linkdir"));

    const found = discoverRecipes({ projectDir: dir });
    expect(found.recipes).toHaveLength(1);
    expect(found.problems.map((problem) => problem.file).toSorted()).toEqual([
      ".autoremediator/recipes/dep/bad.json",
      ".autoremediator/recipes/dep/hostile.json",
    ]);
  });

  it("says when a policy recipes package is not installed, and refuses names that are paths", () => {
    const found = discoverRecipes({ projectDir: dir, installRoot: dir, policyPackages: ["@acme/missing", "../../etc"] });
    expect(found.problems.map((problem) => problem.file)).toEqual(["@acme/missing", "../../etc"]);
    expect(found.recipes).toEqual([]);
  });

  it("skips oversized recipe files", () => {
    put(".autoremediator/recipes/dep/big.json", " ".repeat(600_000));
    expect(discoverRecipes({ projectDir: dir }).problems[0]?.error).toMatch(/larger than/);
  });
});

describe("capturing a recipe from a real repair diff", () => {
  it("keeps project source hunks with their context, drops dependency files, and records the breaking symbols", () => {
    write("package.json", '{"dependencies":{"dep":"1.0.0"}}\n');
    write("src/a.ts", "import { f, g } from 'dep';\n\nexport function run() {\n  f(1, 2);\n  return g();\n}\n");
    write("src/b.ts", "import { f } from 'dep';\nf(3, 4);\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    write("package.json", '{"dependencies":{"dep":"2.0.0"}}\n');
    write("src/a.ts", "import { f, g } from 'dep';\n\nexport function run() {\n  f(1);\n  return g();\n}\n");
    write("src/b.ts", "import { f } from 'dep';\nf(3);\n");
    const diff = git("diff", "HEAD");

    const { recipe, skipped } = captureRecipe({
      diff,
      packageName: "dep",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      fromRange: ">=1.0.0 <2.0.0",
      toRange: ">=2.0.0 <3.0.0",
      isSource: (path) => path.endsWith(".ts"),
      breaking: [{ kind: "diagnostic-TS2554", message: "Expected 1 arguments, but got 2." }],
      evidence: { runId: "run_x", attemptId: "attempt_y", agent: "scripted", checks: [{ name: "typecheck", status: "passed" }] },
    });
    expect(skipped).toEqual([{ file: "package.json", reason: "not project source" }]);
    expect(recipe.hunks).toEqual([
      { before: ["import { f, g } from 'dep';", "", "export function run() {"], remove: ["  f(1, 2);"], add: ["  f(1);"], after: ["  return g();", "}"] },
      { before: ["import { f } from 'dep';"], remove: ["f(3, 4);"], add: ["f(3);"], after: [] },
    ]);
    expect(recipe.observed).toEqual({ fromVersion: "1.0.0", toVersion: "2.0.0" });
    expect(recipe.evidence?.runId).toBe("run_x");

    // The captured recipe re-applies to the code it was captured from, and the result is the repair.
    git("checkout", "-q", "HEAD", "--", ".");
    const sources = files(["src/a.ts", readFileSync(join(dir, "src/a.ts"), "utf8")], ["src/b.ts", readFileSync(join(dir, "src/b.ts"), "utf8")]);
    const plan = planRecipe(recipe, sources);
    if (!plan.ok) throw new Error(plan.reason);
    execFileSync("git", ["apply", "-"], { cwd: dir, input: plan.diff });
    expect(git("diff", "HEAD", "--", "src")).toBe(diff.slice(diff.indexOf("diff --git a/src/a.ts")));
  });

  it("splits changes close together into hunks that all match the original, and does not capture new, deleted or renamed files", () => {
    write("src/a.ts", "import 'dep';\nfoo(1);\nbar(2);\nbaz(3);\n");
    write("src/gone.ts", "x\n");
    write("src/old-name.ts", "import 'dep';\nmoved();\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    write("src/a.ts", "import 'dep';\nfoo();\nbar(2);\nbaz();\n");
    write("src/new.ts", "created\n");
    rmSync(join(dir, "src/gone.ts"));
    git("mv", "src/old-name.ts", "src/new-name.ts");
    git("add", "-A");
    const diff = git("diff", "--cached", "-M");

    const { recipe, skipped } = captureRecipe({
      diff,
      packageName: "dep",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      fromRange: ">=1.0.0 <2.0.0",
      toRange: ">=2.0.0 <3.0.0",
      isSource: () => true,
    });
    expect(recipe.hunks).toHaveLength(2);
    expect(recipe.hunks[0]).toMatchObject({ remove: ["foo(1);"], add: ["foo();"], after: ["bar(2);"] });
    expect(recipe.hunks[1]).toMatchObject({ before: ["bar(2);"], remove: ["baz(3);"], add: ["baz();"] });
    expect(skipped.map((entry) => entry.reason).toSorted()).toEqual(["a deleted file", "a new file", "renamed or copied"]);
  });

  it("refuses when the repair touched no project source", () => {
    write("package.json", '{"a":1}\n');
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    write("package.json", '{"a":2}\n');
    expect(() =>
      captureRecipe({ diff: git("diff"), packageName: "dep", fromVersion: "1.0.0", toVersion: "2.0.0", fromRange: "1.x", toRange: "2.x", isSource: () => false }),
    ).toThrow(/no project source/);
  });

  it("refuses a malformed diff rather than guessing", () => {
    expect(() =>
      captureRecipe({
        diff: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n a\nGARBAGE\n",
        packageName: "dep",
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        fromRange: "1.x",
        toRange: "2.x",
        isSource: () => true,
      }),
    ).toThrow(/malformed/);
  });
});

describe("saving and exporting", () => {
  it("saves into the committed directory once, however often it is captured", () => {
    const first = saveProjectRecipe(dir, { ...dropArgument, observed: { fromVersion: "1.0.0", toVersion: "2.0.0" } });
    expect(first.created).toBe(true);
    expect(first.path).toBe(join(dir, ".autoremediator/recipes/dep/1.0.0-to-2.0.0.json"));
    expect(saveProjectRecipe(dir, { ...dropArgument, observed: { fromVersion: "1.0.0", toVersion: "2.0.0" } }).created).toBe(false);
    const different = recipeSchema.parse({ ...dropArgument, observed: { fromVersion: "1.0.0", toVersion: "2.0.0" }, hunks: [{ remove: ["q();"], add: ["r();"] }] });
    const second = saveProjectRecipe(dir, different);
    expect(second.created).toBe(true);
    expect(second.path).not.toBe(first.path);
    expect(discoverRecipes({ projectDir: dir }).recipes).toHaveLength(2);
  });

  it("writes scoped packages into their own directory and nothing outside it", () => {
    const scoped = recipeSchema.parse({ ...base, package: "@scope/dep", hunks: dropArgument.hunks });
    expect(saveProjectRecipe(dir, scoped).path).toContain(join(".autoremediator", "recipes", "@scope", "dep"));
    expect(() => saveProjectRecipe(dir, { ...dropArgument, package: "../x" })).toThrow(/not a package name/);
  });

  it("exports a publishable package skeleton that discovery can read back as a recipes package", () => {
    saveProjectRecipe(dir, dropArgument);
    const out = join(dir, "out", "pkg");
    const result = exportRecipePackage({ projectDir: dir, outDir: out, name: "@acme/autoremediator-recipes", packages: ["dep"] });
    expect(result.files.filter((file) => file.startsWith("recipes/dep/") && file.endsWith(".json"))).toHaveLength(1);
    expect(result.files).toHaveLength(3);
    const manifest = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as { name: string; files: string[]; keywords: string[] };
    expect(manifest).toMatchObject({ name: "@acme/autoremediator-recipes", files: ["recipes", "README.md"] });
    expect(manifest.keywords).toContain("autoremediator-recipes");
    expect(readFileSync(join(out, "README.md"), "utf8")).toContain('- "@acme/autoremediator-recipes"');

    // Installing it is copying it into node_modules; the policy then trusts it.
    const consumer = join(dir, "consumer");
    mkdirSync(join(consumer, "node_modules/@acme"), { recursive: true });
    execFileSync("cp", ["-R", out, join(consumer, "node_modules/@acme/autoremediator-recipes")]);
    const found = discoverRecipes({ projectDir: consumer, installRoot: consumer, policyPackages: ["@acme/autoremediator-recipes"] });
    expect(found.problems).toEqual([]);
    expect(found.recipes.map((entry) => entry.id)).toEqual([recipeId(dropArgument)]);
  });

  it("refuses to export into a non-empty directory, with a bad name, or with nothing to export", () => {
    expect(() => exportRecipePackage({ projectDir: dir, outDir: join(dir, "o"), name: "@acme/x" })).toThrow(/no recipes/);
    saveProjectRecipe(dir, dropArgument);
    expect(() => exportRecipePackage({ projectDir: dir, outDir: join(dir, "o"), name: "Bad Name" })).toThrow(/not a valid npm package name/);
    expect(() => exportRecipePackage({ projectDir: dir, outDir: join(dir, "o"), name: "@acme/x", packages: ["nothing"] })).toThrow(/no recipes for nothing/);
    expect(() => exportRecipePackage({ projectDir: dir, outDir: dir, name: "@acme/x" })).toThrow(/not empty/);
    expect(existsSync(join(dir, "o"))).toBe(false);
  });
});
