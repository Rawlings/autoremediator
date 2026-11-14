import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import type { RepairBudget, RepairCommands } from "../../platform/repair-agent.js";
import { runCommandCheck, tail } from "../verify/command-check.js";
import { type ScopeGuard, ScopeViolation } from "./scope-guard.js";

const MAX_READ_BYTES = 40_000;
const MAX_READ_LINES = 400;
const MAX_LIST_ENTRIES = 300;
const MAX_SEARCH_MATCHES = 60;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_WRITE_BYTES = 400_000;
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".autoremediator", "dist", "build", "coverage", ".next"]);
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const DOC_FILES = ["CHANGELOG.md", "HISTORY.md", "CHANGES.md", "MIGRATION.md", "UPGRADING.md", "README.md"];
const MAX_DOC_BYTES = 12_000;

/** Mutable record of what an agent did, shared between the tools and the loop around them. */
export interface RepairState {
  commandRuns: number;
  filesChanged: Set<string>;
  submitted?: string;
  gaveUp?: string;
}

export interface RepairToolContext {
  guard: ScopeGuard;
  commands: RepairCommands;
  budget: RepairBudget;
  state: RepairState;
}

const refuse = (error: unknown): string => {
  if (error instanceof ScopeViolation) return `Refused: ${error.message}`;
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
};

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir).toSorted();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) yield* walk(full);
    else if (stats.isFile()) yield full;
  }
}

/** The tools a built-in agent works with. Each is confined by the guard; none runs free-form commands. */
export function createRepairTools(context: RepairToolContext): ToolSet {
  const { guard, commands, budget, state } = context;

  return {
    readFile: tool({
      description:
        "Read a text file in the project (line-numbered). Use startLine/endLine for large files. Credentials and git internals are not readable.",
      inputSchema: z.object({
        path: z.string().describe("Path relative to the project root"),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      }),
      execute: async ({ path, startLine, endLine }) => {
        try {
          const full = guard.assertReadable(path);
          if (!existsSync(full) || !statSync(full).isFile()) return `Error: "${path}" is not a file`;
          const lines = readFileSync(full, "utf8").split("\n");
          const from = Math.max(1, startLine ?? 1);
          const to = Math.min(lines.length, endLine ?? from + MAX_READ_LINES - 1, from + MAX_READ_LINES - 1);
          let text = lines
            .slice(from - 1, to)
            .map((line, index) => `${from + index}\t${line}`)
            .join("\n");
          if (text.length > MAX_READ_BYTES) text = `${text.slice(0, MAX_READ_BYTES)}\n[truncated]`;
          return `${path} (lines ${from}-${to} of ${lines.length})\n${text}`;
        } catch (error) {
          return refuse(error);
        }
      },
    }),

    listFiles: tool({
      description: "List the files under a directory, recursively, skipping node_modules, .git and build output.",
      inputSchema: z.object({ dir: z.string().optional().describe("Directory relative to the project root (default: the root)") }),
      execute: async ({ dir }) => {
        try {
          const full = guard.assertReadable(dir ?? ".");
          const files: string[] = [];
          for (const file of walk(full)) {
            try {
              guard.assertReadable(file);
            } catch {
              continue; // credentials are not even listed
            }
            files.push(guard.relativePath(file));
            if (files.length >= MAX_LIST_ENTRIES) break;
          }
          return files.length > 0 ? files.join("\n") : "(no files)";
        } catch (error) {
          return refuse(error);
        }
      },
    }),

    searchCode: tool({
      description:
        "Search project files for a regular expression (case-sensitive). Returns file:line: text for up to 60 matches.",
      inputSchema: z.object({
        pattern: z.string().describe("JavaScript regular expression"),
        dir: z.string().optional().describe("Directory relative to the project root"),
      }),
      execute: async ({ pattern, dir }) => {
        try {
          let regex: RegExp;
          try {
            regex = new RegExp(pattern);
          } catch {
            return `Error: "${pattern}" is not a valid regular expression`;
          }
          const full = guard.assertReadable(dir ?? ".");
          const matches: string[] = [];
          for (const file of walk(full)) {
            try {
              guard.assertReadable(file);
              if (statSync(file).size > MAX_SEARCH_FILE_BYTES) continue;
              const text = readFileSync(file, "utf8");
              if (text.includes("\0")) continue;
              const lines = text.split("\n");
              for (const [index, line] of lines.entries()) {
                if (regex.test(line)) {
                  matches.push(`${guard.relativePath(file)}:${index + 1}: ${line.trim().slice(0, 200)}`);
                  if (matches.length >= MAX_SEARCH_MATCHES) return matches.join("\n");
                }
              }
            } catch {
              // Unreadable or off-limits files are simply not searched.
            }
          }
          return matches.length > 0 ? matches.join("\n") : "(no matches)";
        } catch (error) {
          return refuse(error);
        }
      },
    }),

    readPackageDocs: tool({
      description:
        "Read the upgrade notes shipped with an installed dependency (changelog, migration guide, README) and where its type definitions are. Use it to learn what changed in the new version.",
      inputSchema: z.object({ packageName: z.string() }),
      execute: async ({ packageName }) => {
        if (!PACKAGE_NAME.test(packageName)) return `Error: "${packageName}" is not a package name`;
        const root = join(guard.root, "node_modules", packageName);
        if (!existsSync(root)) return `Error: ${packageName} is not installed`;
        const out: string[] = [];
        try {
          const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
          const declared = [manifest["types"], manifest["typings"]].find((value) => typeof value === "string");
          out.push(`${packageName}@${JSON.stringify(manifest["version"])} types: ${typeof declared === "string" ? declared : "(none declared)"}`);
        } catch {
          out.push(`${packageName}: package.json unreadable`);
        }
        for (const name of DOC_FILES) {
          const file = join(root, name);
          if (!existsSync(file)) continue;
          out.push(`--- ${name} ---\n${readFileSync(file, "utf8").slice(0, MAX_DOC_BYTES)}`);
          if (name !== "README.md") break;
        }
        return out.join("\n");
      },
    }),

    editFile: tool({
      description:
        "Replace one exact occurrence of oldText with newText in a project source file (.js/.ts and variants). Fails if oldText is missing or appears more than once. Dependency files, CI workflows and config cannot be edited.",
      inputSchema: z.object({ path: z.string(), oldText: z.string().min(1), newText: z.string() }),
      execute: async ({ path, oldText, newText }) => {
        try {
          const full = guard.assertWritable(path);
          if (!existsSync(full)) return `Error: "${path}" does not exist (use writeFile to create a file)`;
          const text = readFileSync(full, "utf8");
          const first = text.indexOf(oldText);
          if (first === -1) return `Error: oldText was not found in "${path}"`;
          if (text.indexOf(oldText, first + 1) !== -1) return `Error: oldText appears more than once in "${path}"; include more context`;
          const next = text.slice(0, first) + newText + text.slice(first + oldText.length);
          if (next.length > MAX_WRITE_BYTES) return "Error: the file would become too large";
          writeFileSync(full, next, "utf8");
          state.filesChanged.add(guard.relativePath(full));
          return `Edited ${path}`;
        } catch (error) {
          return refuse(error);
        }
      },
    }),

    writeFile: tool({
      description: "Create or overwrite a project source file (.js/.ts and variants) with the given content.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        try {
          const full = guard.assertWritable(path);
          if (content.length > MAX_WRITE_BYTES) return "Error: the file is too large";
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, content, "utf8");
          state.filesChanged.add(guard.relativePath(full));
          return `Wrote ${path}`;
        } catch (error) {
          return refuse(error);
        }
      },
    }),

    runCheck: tool({
      description:
        "Run the project's own type check, test suite or build, and return the end of its output. These are the only commands available. Each run counts against a limit.",
      inputSchema: z.object({ name: z.enum(["typecheck", "tests", "build"]) }),
      execute: async ({ name }) => {
        const command = commands[name];
        if (!command || command.length === 0) return `No ${name} command is configured for this project.`;
        if (state.commandRuns >= budget.maxCommandRuns) {
          return `Command limit reached (${budget.maxCommandRuns}). Submit, or give up.`;
        }
        state.commandRuns += 1;
        const outcome = await runCommandCheck(command, guard.root);
        return outcome.passed
          ? `${name}: passed`
          : `${name}: FAILED\n${tail(outcome.output, 40).join("\n")}`;
      },
    }),

    submit: tool({
      description:
        "Call when the checks pass and the project works with the new version. Summarise what you changed. An independent verifier then judges the result; it can send you back.",
      inputSchema: z.object({ summary: z.string() }),
      execute: async ({ summary }) => {
        state.submitted = summary;
        return "Submitted for verification.";
      },
    }),

    giveUp: tool({
      description: "Call if the project cannot reasonably be made to work with the new version.",
      inputSchema: z.object({ reason: z.string() }),
      execute: async ({ reason }) => {
        state.gaveUp = reason;
        return "Noted.";
      },
    }),
  };
}
