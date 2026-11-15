import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getOperation } from "../../catalog/index.js";
import { INSTRUCTED_TOOLS } from "./assets.js";
import { claudeCodePluginFiles } from "./plugin-files.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const files = claudeCodePluginFiles();

describe("Claude Code plugin files", () => {
  it.runIf(process.env.UPDATE_PLUGINS === "1")("rewrites the files on disk", () => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    expect(Object.keys(files).length).toBeGreaterThan(0);
  });

  it("match what is committed (run with UPDATE_PLUGINS=1 to regenerate)", () => {
    const stale = Object.entries(files)
      .filter(
        ([path, content]) =>
          !existsSync(join(root, path)) || readFileSync(join(root, path), "utf8") !== content,
      )
      .map(([path]) => path);
    expect(stale).toEqual([]);
  });

  it("has valid JSON manifests that point at real directories", () => {
    const marketplace = JSON.parse(files[".claude-plugin/marketplace.json"]!) as {
      plugins: Array<{ name: string; source: string }>;
    };
    for (const plugin of marketplace.plugins) {
      const manifest = join(root, plugin.source, ".claude-plugin", "plugin.json");
      expect(
        JSON.parse(files[`${plugin.source.replace("./", "")}/.claude-plugin/plugin.json`]!).name,
      ).toBe(plugin.name);
      expect(Object.keys(files).some((path) => join(root, path) === manifest)).toBe(true);
    }
  });

  it("starts the MCP server that the package ships", () => {
    const mcp = JSON.parse(files["plugins/claude-code/.mcp.json"]!) as {
      mcpServers: { autoremediator: { command: string; args: string[] } };
    };
    expect(mcp.mcpServers.autoremediator.args).toContain("autoremediator-mcp");
    const pkg = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    expect(Object.keys(pkg.bin)).toContain("autoremediator-mcp");
  });

  it("gives every skill, command and agent frontmatter with a description", () => {
    const missing = Object.entries(files)
      .filter(([path]) => path.endsWith(".md"))
      .filter(
        ([, content]) =>
          !/^description: .+$/m.test(/^---\n([\s\S]*?)\n---\n/.exec(content)?.[1] ?? ""),
      )
      .map(([path]) => path);
    expect(missing).toEqual([]);
  });

  it("names only tools that exist", () => {
    for (const tool of INSTRUCTED_TOOLS) expect(getOperation(tool)).toBeDefined();
    const referenced = new Set<string>();
    for (const content of Object.values(files)) {
      for (const [, word] of content.matchAll(/`([a-z][A-Za-z]+)`/g))
        if (word && getOperation(word)) referenced.add(word);
    }
    for (const word of referenced) expect(INSTRUCTED_TOOLS as readonly string[]).toContain(word);
  });
});
