import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Contributor skills are written once, in `.github/skills`, and mirrored byte for byte into
 * `.claude/skills` because Claude Code reads that folder and Copilot reads the other. Edit the
 * `.github` copy; run `UPDATE_SKILLS=1 pnpm --filter autoremediator test skills-mirror` to refresh.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const source = join(root, ".github", "skills");
const mirror = join(root, ".claude", "skills");

function skillNames(): string[] {
  return readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(source, entry.name, "SKILL.md")))
    .map((entry) => entry.name);
}

describe("contributor skills mirror", () => {
  it.runIf(process.env["UPDATE_SKILLS"] === "1")(
    "rewrites .claude/skills from .github/skills",
    () => {
      const names = skillNames();
      mkdirSync(mirror, { recursive: true });
      for (const name of readdirSync(mirror)) {
        if (!names.includes(name)) rmSync(join(mirror, name), { recursive: true, force: true });
      }
      for (const name of names) {
        mkdirSync(join(mirror, name), { recursive: true });
        writeFileSync(join(mirror, name, "SKILL.md"), readFileSync(join(source, name, "SKILL.md")));
      }
      expect(names.length).toBeGreaterThan(0);
    },
  );

  it("has a byte-identical copy of every skill (run with UPDATE_SKILLS=1 to refresh)", () => {
    const stale = skillNames().filter((name) => {
      const copy = join(mirror, name, "SKILL.md");
      return (
        !existsSync(copy) ||
        readFileSync(copy, "utf8") !== readFileSync(join(source, name, "SKILL.md"), "utf8")
      );
    });
    expect(stale).toEqual([]);
  });

  it("keeps no copy of a skill that was removed from .github/skills", () => {
    const names = skillNames();
    const orphans = existsSync(mirror)
      ? readdirSync(mirror).filter((name) => !names.includes(name))
      : [];
    expect(orphans).toEqual([]);
  });

  it("gives every skill a name that matches its folder and a description", () => {
    const bad = skillNames().filter((name) => {
      const text = readFileSync(join(source, name, "SKILL.md"), "utf8");
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
      return (
        !new RegExp(`^name: ${name}$`, "m").test(frontmatter) ||
        !/^description: \S/m.test(frontmatter)
      );
    });
    expect(bad).toEqual([]);
  });
});
