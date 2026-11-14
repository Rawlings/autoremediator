import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  type Document,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

import { BLOCK_BEGIN, BLOCK_END } from "./scripts.js";
import type { HookName, HookState } from "./types.js";

/**
 * Safe merges for the files `hook install` and `hook uninstall` touch. Rules: text outside the
 * marked block (or outside the entry we own) is never changed, an entry we did not write is never
 * replaced, and a file we cannot parse or safely extend is reported as a conflict.
 */
export type HookMergeResult = { content: string } | { conflict: string } | { remove: true };

/** Where a block sits in a file, or why it cannot be located. */
type BlockLocation = { start: number; end: number } | { none: true } | { conflict: string };

function locateBlock(lines: string[]): BlockLocation {
  const begins = lines.flatMap((line, index) => (line.trim() === BLOCK_BEGIN ? [index] : []));
  const ends = lines.flatMap((line, index) => (line.trim() === BLOCK_END ? [index] : []));
  if (begins.length === 0 && ends.length === 0) return { none: true };
  const start = begins[0];
  const end = ends[0];
  if (
    begins.length !== 1 ||
    ends.length !== 1 ||
    start === undefined ||
    end === undefined ||
    end < start
  ) {
    return { conflict: "has an unmatched autoremediator marker, so it was left alone" };
  }
  return { start, end };
}

const SHELL_SHEBANG = /^#!\s*\S*\/(?:env\s+(?:-\S+\s+)*)?(?:ba|z|da|k|a)?sh\b/;

/** Lines that remain when only boilerplate is left around a removed block. */
function isBoilerplate(line: string): boolean {
  const text = line.trim();
  return text === "" || text.startsWith("#!") || /husky\.sh["']?\s*$/.test(text);
}

export interface ShellMergeOptions {
  /** Line written after the shebang in a new file (for example husky 8's `husky.sh` import). */
  preamble?: string;
}

/**
 * Insert or refresh the marked block in a shell hook file. A file that is not a shell script, or
 * whose last top-level command is `exit` or `exec` (so appended code would never run), is a conflict.
 */
export function mergeShellBlock(
  existing: string | undefined,
  block: string,
  options: ShellMergeOptions = {},
): HookMergeResult {
  if (existing === undefined || existing.trim() === "") {
    const preamble = options.preamble ? `${options.preamble}\n` : "";
    return { content: `#!/bin/sh\n${preamble}\n${block}\n` };
  }
  const lines = existing.split("\n");
  const located = locateBlock(lines);
  if ("conflict" in located) return { conflict: located.conflict };
  if ("start" in located) {
    const next = [
      ...lines.slice(0, located.start),
      ...block.split("\n"),
      ...lines.slice(located.end + 1),
    ];
    return { content: next.join("\n") };
  }
  const first = lines[0] ?? "";
  if (first.startsWith("#!") && !SHELL_SHEBANG.test(first)) {
    return { conflict: "is not a shell script, so the hook was not added; add it by hand" };
  }
  const last = lines
    .toReversed()
    .find((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  if (last !== undefined && /^(exit|exec)\b/.test(last)) {
    return {
      conflict: `ends with "${last.trim()}", so an added block would never run; add it by hand`,
    };
  }
  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  return { content: `${base}\n${block}\n` };
}

/** Remove the marked block. A file that held nothing else is removed. */
export function removeShellBlock(existing: string | undefined): HookMergeResult {
  if (existing === undefined) return { content: "" };
  const lines = existing.split("\n");
  const located = locateBlock(lines);
  if ("conflict" in located) return { conflict: located.conflict };
  if ("none" in located) return { content: existing };
  const before = lines.slice(0, located.start);
  const after = lines.slice(located.end + 1);
  // `hook install` put a blank line before the block; take it away again.
  if (before.at(-1)?.trim() === "" && (after.length === 0 || after[0]?.trim() === "")) before.pop();
  const rest = [...before, ...after];
  if (rest.every((line) => isBoilerplate(line))) return { remove: true };
  return { content: rest.join("\n") };
}

export function shellBlockState(existing: string | undefined, block: string): HookState {
  if (existing === undefined) return "missing";
  const lines = existing.split("\n");
  const located = locateBlock(lines);
  if ("conflict" in located) return "conflict";
  if ("none" in located) return "missing";
  return lines.slice(located.start, located.end + 1).join("\n") === block
    ? "installed"
    : "modified";
}

// ---------------------------------------------------------------------------
// lefthook

const LEFTHOOK_NAME = "autoremediator";

function newDocument(existing: string | undefined): Document | { conflict: string } {
  const doc = parseDocument(existing ?? "", { keepSourceTokens: false });
  if (doc.errors.length > 0) return { conflict: "is not valid YAML, so it was left alone" };
  if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)) {
    doc.contents = doc.createNode({}) as never;
  }
  if (!isMap(doc.contents)) return { conflict: "is not a YAML mapping, so it was left alone" };
  return doc;
}

/** A child node of a mapping, untyped so callers narrow it with `isMap` / `isSeq`. */
function child(map: YAMLMap, key: string): unknown {
  return map.get(key, true);
}

function blockScalar(text: string): Scalar {
  const scalar = new Scalar(`${text}\n`);
  scalar.type = Scalar.BLOCK_LITERAL;
  return scalar;
}

function render(doc: Document): string {
  return doc.toString({ lineWidth: 0 });
}

function runText(node: unknown): string | undefined {
  const value = isScalar(node) ? node.value : node;
  return typeof value === "string" ? value.trim() : undefined;
}

/** Find the entry we own in a lefthook hook: a command named `autoremediator`, or a job of that name. */
function findLefthookEntry(
  hookNode: unknown,
): { kind: "command" | "job"; run: string | undefined; index?: number } | undefined {
  if (!isMap(hookNode)) return undefined;
  const commands = child(hookNode, "commands");
  if (isMap(commands) && commands.has(LEFTHOOK_NAME)) {
    const entry = commands.get(LEFTHOOK_NAME, true);
    return { kind: "command", run: isMap(entry) ? runText(entry.get("run", true)) : undefined };
  }
  const jobs = child(hookNode, "jobs");
  if (isSeq(jobs)) {
    const index = jobs.items.findIndex((job) => isMap(job) && job.get("name") === LEFTHOOK_NAME);
    const job = index === -1 ? undefined : jobs.items[index];
    if (index !== -1)
      return { kind: "job", run: isMap(job) ? runText(job.get("run", true)) : undefined, index };
  }
  return undefined;
}

function isOurs(run: string | undefined): boolean {
  return run?.includes(BLOCK_BEGIN) === true;
}

export function lefthookState(
  existing: string | undefined,
  hook: HookName,
  block: string,
): HookState {
  if (existing === undefined) return "missing";
  const doc = newDocument(existing);
  if ("conflict" in doc) return "conflict";
  const entry = findLefthookEntry(child(doc.contents as YAMLMap, hook));
  if (!entry) return "missing";
  if (!isOurs(entry.run)) return "conflict";
  return entry.run === block ? "installed" : "modified";
}

/** Add (or refresh) a `commands.autoremediator` entry under each hook. */
export function mergeLefthook(
  existing: string | undefined,
  blocks: Partial<Record<HookName, string>>,
): HookMergeResult {
  const doc = newDocument(existing);
  if ("conflict" in doc) return doc;
  const root = doc.contents as YAMLMap;
  for (const [hook, block] of Object.entries(blocks)) {
    const hookNode = child(root, hook);
    if (hookNode !== undefined && hookNode !== null && !isMap(hookNode)) {
      return { conflict: `has a "${hook}" that is not a mapping, so it was left alone` };
    }
    const entry = findLefthookEntry(hookNode);
    if (entry && !isOurs(entry.run)) {
      return {
        conflict: `already has a "${LEFTHOOK_NAME}" entry under "${hook}" that Autoremediator did not write, so it was left alone`,
      };
    }
    const scalar = blockScalar(block);
    if (entry?.kind === "job") {
      const jobs = isMap(hookNode) ? child(hookNode, "jobs") : undefined;
      const job = isSeq(jobs) ? jobs.items[entry.index ?? 0] : undefined;
      if (isMap(job)) job.set("run", scalar);
    } else if (
      isMap(hookNode) &&
      isSeq(child(hookNode, "jobs")) &&
      !isMap(child(hookNode, "commands"))
    ) {
      (child(hookNode, "jobs") as YAMLSeq).add(
        doc.createNode({ name: LEFTHOOK_NAME, run: scalar }),
      );
    } else {
      doc.setIn([hook, "commands", LEFTHOOK_NAME], doc.createNode({ run: scalar }));
    }
  }
  return { content: render(doc) };
}

export function removeLefthook(existing: string | undefined, hooks: HookName[]): HookMergeResult {
  if (existing === undefined) return { content: "" };
  const doc = newDocument(existing);
  if ("conflict" in doc) return doc;
  const root = doc.contents as YAMLMap;
  let changed = false;
  for (const hook of hooks) {
    const hookNode = child(root, hook);
    const entry = findLefthookEntry(hookNode);
    if (!entry) continue;
    if (!isOurs(entry.run)) {
      return {
        conflict: `has a "${LEFTHOOK_NAME}" entry under "${hook}" that Autoremediator did not write, so it was left alone`,
      };
    }
    changed = true;
    if (entry.kind === "command") {
      doc.deleteIn([hook, "commands", LEFTHOOK_NAME]);
      const commands = doc.getIn([hook, "commands"], true);
      if (isMap(commands) && commands.items.length === 0) doc.deleteIn([hook, "commands"]);
    } else {
      doc.deleteIn([hook, "jobs", entry.index ?? 0]);
      const jobs = doc.getIn([hook, "jobs"], true);
      if (isSeq(jobs) && jobs.items.length === 0) doc.deleteIn([hook, "jobs"]);
    }
    const remaining = child(root, hook);
    if (isMap(remaining) && remaining.items.length === 0) root.delete(hook);
  }
  if (!changed) return { content: existing };
  return root.items.length === 0 ? { remove: true } : { content: render(doc) };
}

// ---------------------------------------------------------------------------
// pre-commit framework

const PRE_COMMIT_ID_PREFIX = "autoremediator-";

export function preCommitId(hook: HookName): string {
  return `${PRE_COMMIT_ID_PREFIX}${hook}`;
}

function preCommitEntry(hook: HookName, block: string): Record<string, unknown> {
  return {
    id: preCommitId(hook),
    name: `autoremediator (${hook})`,
    entry: "sh -c",
    args: [blockScalar(block)],
    language: "system",
    stages: [hook],
    pass_filenames: false,
    always_run: true,
    verbose: true,
  };
}

function findPreCommitHook(
  doc: Document,
  hook: HookName,
): { repoIndex: number; hookIndex: number; node: YAMLMap } | undefined {
  const repos = child(doc.contents as YAMLMap, "repos");
  if (!isSeq(repos)) return undefined;
  for (const [repoIndex, repo] of repos.items.entries()) {
    if (!isMap(repo) || repo.get("repo") !== "local") continue;
    const hooks = child(repo, "hooks");
    if (!isSeq(hooks)) continue;
    const hookIndex = hooks.items.findIndex(
      (item) => isMap(item) && item.get("id") === preCommitId(hook),
    );
    const node = hooks.items[hookIndex];
    if (hookIndex !== -1 && isMap(node)) return { repoIndex, hookIndex, node };
  }
  return undefined;
}

function preCommitRun(node: YAMLMap): string | undefined {
  const args = child(node, "args");
  return isSeq(args) ? runText(args.items[0]) : undefined;
}

export function preCommitState(
  existing: string | undefined,
  hook: HookName,
  block: string,
): HookState {
  if (existing === undefined) return "missing";
  const doc = newDocument(existing);
  if ("conflict" in doc) return "conflict";
  const found = findPreCommitHook(doc, hook);
  if (!found) return "missing";
  const run = preCommitRun(found.node);
  if (!isOurs(run)) return "conflict";
  return run === block ? "installed" : "modified";
}

/** Add a `repo: local` hook per Autoremediator hook, joining an existing local repo when there is one. */
export function mergePreCommit(
  existing: string | undefined,
  blocks: Partial<Record<HookName, string>>,
): HookMergeResult {
  const doc = newDocument(existing);
  if ("conflict" in doc) return doc;
  const root = doc.contents as YAMLMap;
  let repos = child(root, "repos");
  if (repos === undefined || repos === null) {
    repos = doc.createNode([]) as YAMLSeq;
    root.set("repos", repos);
  }
  if (!isSeq(repos)) return { conflict: 'has a "repos" that is not a list, so it was left alone' };

  for (const [name, block] of Object.entries(blocks) as Array<[HookName, string]>) {
    const found = findPreCommitHook(doc, name);
    if (found) {
      if (!isOurs(preCommitRun(found.node))) {
        return {
          conflict: `already has a hook "${preCommitId(name)}" that Autoremediator did not write, so it was left alone`,
        };
      }
      const hooks = child(repos.items[found.repoIndex] as YAMLMap, "hooks") as YAMLSeq;
      hooks.items[found.hookIndex] = doc.createNode(preCommitEntry(name, block));
      continue;
    }
    const localRepo = repos.items.find(
      (repo) => isMap(repo) && repo.get("repo") === "local" && isSeq(child(repo, "hooks")),
    );
    if (isMap(localRepo)) {
      (child(localRepo, "hooks") as YAMLSeq).add(doc.createNode(preCommitEntry(name, block)));
    } else {
      repos.add(doc.createNode({ repo: "local", hooks: [preCommitEntry(name, block)] }));
    }
  }
  return { content: render(doc) };
}

export function removePreCommit(existing: string | undefined, hooks: HookName[]): HookMergeResult {
  if (existing === undefined) return { content: "" };
  const doc = newDocument(existing);
  if ("conflict" in doc) return doc;
  let changed = false;
  for (const hook of hooks) {
    const found = findPreCommitHook(doc, hook);
    if (!found) continue;
    if (!isOurs(preCommitRun(found.node))) {
      return {
        conflict: `has a hook "${preCommitId(hook)}" that Autoremediator did not write, so it was left alone`,
      };
    }
    changed = true;
    doc.deleteIn(["repos", found.repoIndex, "hooks", found.hookIndex]);
    const remaining = doc.getIn(["repos", found.repoIndex, "hooks"], true);
    if (isSeq(remaining) && remaining.items.length === 0) doc.deleteIn(["repos", found.repoIndex]);
  }
  return changed ? { content: render(doc) } : { content: existing };
}
