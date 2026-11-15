/**
 * Turn a recipe into a unified diff for a particular project, or refuse.
 *
 * Matching is exact: a hunk's context and removed lines must appear, line for line and character
 * for character, in a file that refers to the recipe's package. There is no fuzz, no offset
 * guessing and no whitespace tolerance; anything that does not match is not touched. A recipe whose
 * required hunks do not all match yields no diff at all. This module never touches the disk and
 * never runs anything: it is text in, text out.
 */
import { satisfies, valid } from "semver";

import type { Recipe, RecipeHunk } from "./schema.js";

export const MAX_FILES_CHANGED = 50;
export const MAX_CHANGES = 200;
const CONTEXT = 3;
const MAX_FILE_BYTES = 1_000_000;

export interface SourceFile {
  /** Path relative to the repository root, `/`-separated. */
  path: string;
  text: string;
}

export interface RecipeMatch {
  /** Index into the recipe's hunks. */
  hunk: number;
  file: string;
  /** 1-based line of the first line replaced (or the line after which text is inserted). */
  line: number;
}

export type RecipePlan =
  | { ok: true; diff: string; files: string[]; matches: RecipeMatch[]; unmatchedOptional: number[] }
  | { ok: false; reason: string };

const options = { includePrerelease: true } as const;

/** Whether a recipe is for upgrading from `fromVersion` to `toVersion`. */
export function appliesTo(
  recipe: Pick<Recipe, "fromRange" | "toRange">,
  fromVersion: string,
  toVersion: string,
): boolean {
  if (!valid(fromVersion) || !valid(toVersion)) return false;
  return (
    satisfies(fromVersion, recipe.fromRange, options) &&
    satisfies(toVersion, recipe.toRange, options)
  );
}

/** Whether source text refers to the package: a quoted import or require of it or of a subpath. */
export function mentionsPackage(text: string, packageName: string): boolean {
  return ['"', "'", "`"].some(
    (quote) =>
      text.includes(`${quote}${packageName}${quote}`) || text.includes(`${quote}${packageName}/`),
  );
}

const SAFE_PATH = /^[A-Za-z0-9_@+.,=-]+(?:\/[A-Za-z0-9_@+.,=-]+)*$/;

/** A path safe to put in a diff header: plain characters, no `.` or `..` segments. */
export function isSafeDiffPath(path: string): boolean {
  return (
    SAFE_PATH.test(path) && path.split("/").every((segment) => segment !== "." && segment !== "..")
  );
}

interface Edit {
  hunk: number;
  start: number;
  delLength: number;
  add: readonly string[];
}

function findAll(lines: readonly string[], pattern: readonly string[]): number[] {
  const found: number[] = [];
  const first = pattern[0];
  for (let index = 0; index + pattern.length <= lines.length; index += 1) {
    if (lines[index] !== first) continue;
    let same = true;
    for (let offset = 1; offset < pattern.length; offset += 1) {
      if (lines[index + offset] !== pattern[offset]) {
        same = false;
        break;
      }
    }
    if (same) found.push(index);
  }
  return found;
}

const describeHunk = (hunk: RecipeHunk): string => {
  const anchor =
    [...hunk.remove, ...hunk.before, ...hunk.after].find((line) => line.trim().length > 0) ?? "";
  return JSON.stringify(anchor.trim().slice(0, 80));
};

function renderFileDiff(path: string, old: readonly string[], edits: readonly Edit[]): string {
  const groups: Edit[][] = [];
  for (const edit of edits) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (group && previous && edit.start - (previous.start + previous.delLength) <= 2 * CONTEXT)
      group.push(edit);
    else groups.push([edit]);
  }

  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  let delta = 0;
  for (const group of groups) {
    const first = group[0]!;
    const last = group.at(-1)!;
    const oldStart = Math.max(0, first.start - CONTEXT);
    const oldEnd = Math.min(old.length, last.start + last.delLength + CONTEXT);
    const body: string[] = [];
    let cursor = oldStart;
    let oldCount = 0;
    let newCount = 0;
    for (const edit of group) {
      for (; cursor < edit.start; cursor += 1) {
        body.push(` ${old[cursor]}`);
        oldCount += 1;
        newCount += 1;
      }
      for (let index = 0; index < edit.delLength; index += 1) {
        body.push(`-${old[edit.start + index]}`);
        oldCount += 1;
      }
      for (const line of edit.add) {
        body.push(`+${line}`);
        newCount += 1;
      }
      cursor = edit.start + edit.delLength;
    }
    for (; cursor < oldEnd; cursor += 1) {
      body.push(` ${old[cursor]}`);
      oldCount += 1;
      newCount += 1;
    }
    const newStart = oldStart + delta;
    out.push(
      `@@ -${oldCount === 0 ? oldStart : oldStart + 1},${oldCount} +${newCount === 0 ? newStart : newStart + 1},${newCount} @@`,
      ...body,
    );
    delta += newCount - oldCount;
  }
  return `${out.join("\n")}\n`;
}

/**
 * Plan a recipe against a project's source files. Files that do not refer to the package, that
 * are large, use CRLF line endings or lack a final newline are not candidates (so they are never
 * changed) rather than approximated.
 */
export function planRecipe(recipe: Recipe, files: readonly SourceFile[]): RecipePlan {
  const edits = new Map<string, { lines: string[]; edits: Edit[] }>();
  const matchedHunks = new Set<number>();
  let total = 0;

  for (const file of files) {
    if (!isSafeDiffPath(file.path)) continue;
    if (file.text.length > MAX_FILE_BYTES || file.text.includes("\r") || !file.text.endsWith("\n"))
      continue;
    if (!mentionsPackage(file.text, recipe.package)) continue;
    const lines = file.text.slice(0, -1).split("\n");

    for (const [index, hunk] of recipe.hunks.entries()) {
      const pattern = [...hunk.before, ...hunk.remove, ...hunk.after];
      for (const found of findAll(lines, pattern)) {
        total += 1;
        if (total > MAX_CHANGES)
          return { ok: false, reason: `the recipe would make more than ${MAX_CHANGES} changes` };
        matchedHunks.add(index);
        const entry = edits.get(file.path) ?? { lines, edits: [] };
        entry.edits.push({
          hunk: index,
          start: found + hunk.before.length,
          delLength: hunk.remove.length,
          add: hunk.add,
        });
        edits.set(file.path, entry);
      }
    }
  }

  const missing = recipe.hunks.flatMap((hunk, index) =>
    !matchedHunks.has(index) && !hunk.optional ? [index] : [],
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `hunk ${missing.map((index) => `${index + 1} ${describeHunk(recipe.hunks[index]!)}`).join(", ")} does not match any source file exactly (the code differs from the code the recipe was made for)`,
    };
  }
  if (edits.size === 0) return { ok: false, reason: "no source file matches the recipe" };
  if (edits.size > MAX_FILES_CHANGED)
    return { ok: false, reason: `the recipe would change more than ${MAX_FILES_CHANGED} files` };

  const matches: RecipeMatch[] = [];
  const diffs: string[] = [];
  for (const [path, entry] of [...edits.entries()].toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    // An insertion goes in before a replacement that starts at the same line.
    const sorted = entry.edits.toSorted(
      (a, b) => a.start - b.start || a.delLength - b.delLength || a.hunk - b.hunk,
    );
    for (const [index, edit] of sorted.entries()) {
      const previous = sorted[index - 1];
      const bothInsertions =
        previous?.start === edit.start && previous.delLength === 0 && edit.delLength === 0;
      if (previous && (edit.start < previous.start + previous.delLength || bothInsertions)) {
        return {
          ok: false,
          reason: `hunks ${previous.hunk + 1} and ${edit.hunk + 1} overlap in ${path}`,
        };
      }
      matches.push({ hunk: edit.hunk, file: path, line: edit.start + 1 });
    }
    diffs.push(renderFileDiff(path, entry.lines, sorted));
  }

  return {
    ok: true,
    diff: diffs.join(""),
    files: [...edits.keys()].toSorted(),
    matches,
    unmatchedOptional: recipe.hunks.flatMap((_, index) => (matchedHunks.has(index) ? [] : [index])),
  };
}
