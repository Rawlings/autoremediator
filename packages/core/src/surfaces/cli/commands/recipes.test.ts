/** `autoremediator recipes ...` against the real API and a real project directory. */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recipeId, recipeSchema, serializeRecipe } from "../../../features/recipes/schema.js";
import { createProgram } from "../program.js";

let dir: string;
let output: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "cli-recipes-")));
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const recipe = recipeSchema.parse({
  schemaVersion: 1,
  package: "dep",
  fromRange: ">=1.0.0 <2.0.0",
  toRange: ">=2.0.0 <3.0.0",
  summary: "f lost its second argument",
  breaking: [{ kind: "diagnostic-TS2554", message: "Expected 1 arguments, but got 2." }],
  hunks: [
    { before: ["import { f } from 'dep';"], remove: ["f(1, 2);"], add: ["f(1);"], after: [] },
  ],
});
const put = () => {
  const file = join(dir, ".autoremediator/recipes/dep/1.0.0-to-2.0.0.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeRecipe(recipe));
};
const run = (...args: string[]) =>
  createProgram().parseAsync(["recipes", ...args, "--cwd", dir], { from: "user" });

describe("recipes list and show", () => {
  it("says there are none", async () => {
    await run("list");
    expect(output).toBe("No recipes.\n");
  });

  it("lists, filters by upgrade, and shows a recipe's hunks", async () => {
    put();
    await run("list", "--from", "1.2.0", "--to", "2.0.0");
    expect(output).toContain(
      `${recipeId(recipe)}  dep >=1.0.0 <2.0.0 -> >=2.0.0 <3.0.0  1 hunk(s)  this project  [applies]`,
    );
    output = "";
    await run("list", "--from", "1.2.0", "--to", "3.0.0");
    expect(output).toContain("[does not apply]");
    output = "";
    await run("list", "--package", "other");
    expect(output).toBe("No recipes.\n");

    output = "";
    await run("show", recipeId(recipe));
    expect(output).toContain("broke: diagnostic-TS2554: Expected 1 arguments, but got 2.");
    expect(output).toContain("-  f(1, 2);\n+  f(1);");

    output = "";
    await run("show", recipeId(recipe), "--output-format", "json");
    expect((JSON.parse(output) as { recipe: { hunks: unknown[] } }).recipe.hunks).toHaveLength(1);
    await expect(run("show", "dep#0000000000")).rejects.toThrow(/Recipe not found/);
  });

  it("lists unusable recipe files instead of hiding them", async () => {
    const file = join(dir, ".autoremediator/recipes/dep/broken.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{}");
    await run("list");
    expect(output).toMatch(
      /unusable: \.autoremediator\/recipes\/dep\/broken\.json: invalid recipe/,
    );
  });
});

describe("recipes export", () => {
  it("writes a package skeleton and publishes nothing", async () => {
    put();
    const out = join(dir, "pkg");
    await run(
      "export",
      "--name",
      "@acme/autoremediator-recipes",
      "--out",
      out,
      "--package-version",
      "1.2.3",
    );
    expect(JSON.parse(readFileSync(join(out, "package.json"), "utf8"))).toMatchObject({
      name: "@acme/autoremediator-recipes",
      version: "1.2.3",
    });
    expect(readdirSync(join(out, "recipes/dep"))).toHaveLength(1);
    expect(output).toContain("npm publish");
  });

  it("refuses a name that is not an npm package name", async () => {
    put();
    await expect(run("export", "--name", "Not Valid", "--out", join(dir, "pkg"))).rejects.toThrow(
      /not a valid npm package name/,
    );
  });
});

describe("recipes capture", () => {
  it("needs a run that exists", async () => {
    await expect(run("capture", "--run", "run_aaaaaaaaaaaaaaaaaaaa")).rejects.toThrow(
      /run_aaaaaaaaaaaaaaaaaaaa/,
    );
  });
});
