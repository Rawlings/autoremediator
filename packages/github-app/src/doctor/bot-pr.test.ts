import { describe, expect, it } from "vitest";

import { fenced, oneLine } from "../diagnostics/sanitize.js";
import { isRepairablePath, repairPathProblem } from "../healing/safe-paths.js";
import { botKindOfBranch, botKindOfLogin, detectBotPr, isForkPullRequest } from "./bot-pr.js";

describe("bot detection", () => {
  it("recognises the branch prefixes", () => {
    expect(botKindOfBranch("dependabot/npm_and_yarn/lodash-4.17.21")).toBe("dependabot");
    expect(botKindOfBranch("renovate/lodash-4.x")).toBe("renovate");
    expect(botKindOfBranch("feature/dependabot/x")).toBeUndefined();
    expect(botKindOfBranch("dependabot")).toBeUndefined();
    expect(botKindOfBranch("autoremediator/cve-1")).toBeUndefined();
  });

  it("recognises the author logins, and nothing that merely resembles them", () => {
    expect(botKindOfLogin("dependabot[bot]")).toBe("dependabot");
    expect(botKindOfLogin("renovate[bot]")).toBe("renovate");
    expect(botKindOfLogin("Renovate[bot]")).toBe("renovate");
    expect(botKindOfLogin("dependabot")).toBeUndefined();
    expect(botKindOfLogin("dependabot[bot]-evil")).toBeUndefined();
    expect(botKindOfLogin("x[bot]")).toBeUndefined();
    expect(botKindOfLogin(undefined)).toBeUndefined();
  });

  it("accepts either the branch or the author", () => {
    expect(detectBotPr("custom-branch", "renovate[bot]")).toBe("renovate");
    expect(detectBotPr("dependabot/x", "alice")).toBe("dependabot");
    expect(detectBotPr("custom-branch", "alice")).toBeUndefined();
  });
});

describe("isForkPullRequest", () => {
  it("is false only when head and base are the same repository", () => {
    expect(isForkPullRequest({ head: { repo: { id: 1 } }, base: { repo: { id: 1 } } })).toBe(false);
    expect(isForkPullRequest({ head: { repo: { id: 2 } }, base: { repo: { id: 1 } } })).toBe(true);
    expect(
      isForkPullRequest({
        head: { repo: { full_name: "O/R" } },
        base: { repo: { full_name: "o/r" } },
      }),
    ).toBe(false);
    expect(
      isForkPullRequest({
        head: { repo: { full_name: "x/r" } },
        base: { repo: { full_name: "o/r" } },
      }),
    ).toBe(true);
  });

  it("treats a missing head repository, or no information, as a fork", () => {
    expect(isForkPullRequest({ head: { repo: null }, base: { repo: { id: 1 } } })).toBe(true);
    expect(isForkPullRequest({})).toBe(true);
    expect(isForkPullRequest({ head: { repo: {} }, base: { repo: {} } })).toBe(true);
  });
});

describe("repair path guard", () => {
  it.each(["src/app.ts", "lib/a/b.tsx", "index.js", "scripts/x.mjs", "src/a.test.ts"])(
    "allows %s",
    (path) => {
      expect(isRepairablePath(path)).toBe(true);
    },
  );

  it.each([
    ["package-lock.json", "lockfile"],
    ["pnpm-lock.yaml", "lockfile"],
    ["packages/a/yarn.lock", "lockfile"],
    ["npm-shrinkwrap.json", "lockfile"],
    [".github/workflows/ci.js", "workflow, policy or repository configuration"],
    [".GitHub/workflows/ci.ts", "workflow, policy or repository configuration"],
    [".github/autoremediator.yml", "workflow, policy or repository configuration"],
    [".autoremediator.json", "autoremediator policy"],
    ["package.json", "dependency manifest"],
    ["a/package.json", "dependency manifest"],
    ["../x.ts", "outside the repository"],
    ["src/../../x.ts", "outside the repository"],
    ["/abs/x.ts", "absolute path"],
    [String.raw`src\x.ts`, "unsupported characters"],
    ["src/x.ts\0.png", "unsupported characters"],
    ["node_modules/a/index.js", "not a source file"],
    [".git/hooks/pre-commit.js", "not a source file"],
    ["README.md", "not a source file"],
    ["Dockerfile", "not a source file"],
    ["", "path length"],
    [`${"a/".repeat(200)}x.ts`, "path length"],
  ])("refuses %j (%s)", (path, reason) => {
    expect(repairPathProblem(path)).toBe(reason);
  });
});

describe("comment sanitising", () => {
  it("flattens a line and defuses anything that could close a code fence", () => {
    expect(oneLine("a ```\nb\u0000c‮d `x`", 100)).toBe("a ''' b c d 'x'");
  });

  it("caps the length", () => {
    expect(oneLine("x".repeat(500), 20)).toHaveLength(20);
  });

  it("fenced output has exactly one opening and one closing fence", () => {
    const block = fenced(["```", "``` evil", "ok"]);
    expect(block.match(/```/g)).toHaveLength(2);
  });
});
