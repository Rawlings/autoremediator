/**
 * Turn the diff of a successful repair into a recipe.
 *
 * Only the project's own source is captured; dependency files and anything unusual in the diff
 * (new, deleted, renamed or binary files, mode changes, a missing final newline) are left out, and
 * said so. The hunks keep their git context lines, so the recipe re-applies only where the same
 * code is found.
 */
import {
  RECIPE_SCHEMA_VERSION,
  recipeSchema,
  type Recipe,
  type RecipeBreaking,
  type RecipeHunk,
} from "./schema.js";

export interface CaptureInput {
  /** A unified diff, as `git diff` prints it. */
  diff: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  /** Whether a changed path is project source (the caller knows what counts). */
  isSource: (path: string) => boolean;
  fromRange: string;
  toRange: string;
  summary?: string;
  breaking?: RecipeBreaking[];
  evidence?: Recipe["evidence"];
}

export interface CaptureResult {
  recipe: Recipe;
  /** Files in the diff that were not captured, with the reason. */
  skipped: { file: string; reason: string }[];
}

const HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface ParsedHunk {
  lines: { kind: " " | "-" | "+"; text: string }[];
}

interface ParsedFile {
  path: string;
  hunks: ParsedHunk[];
  skip?: string;
}

/** Parse the file sections of a unified diff, using the hunk line counts (not the content) to find hunk ends. */
function parseDiff(diff: string): ParsedFile[] {
  const lines = diff.split("\n");
  const files: ParsedFile[] = [];
  let current: ParsedFile | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const header = HEADER.exec(line);
    if (header) {
      const [, from, to] = header;
      current = { path: to!, hunks: [], ...(from === to ? {} : { skip: "renamed or copied" }) };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (/^(new|deleted) file mode /.test(line))
      current.skip = line.startsWith("new") ? "a new file" : "a deleted file";
    else if (/^(old|new) mode /.test(line)) current.skip = "a file mode change";
    else if (/^(rename|copy) (from|to) /.test(line)) current.skip = "renamed or copied";
    else if (/^(Binary files |GIT binary patch)/.test(line)) current.skip = "binary";
    const hunk = HUNK.exec(line);
    if (!hunk) continue;
    let oldLeft = Number(hunk[2] ?? 1);
    let newLeft = Number(hunk[4] ?? 1);
    const parsed: ParsedHunk = { lines: [] };
    while ((oldLeft > 0 || newLeft > 0) && index + 1 < lines.length) {
      index += 1;
      const text = lines[index]!;
      const kind = text[0];
      if (kind === " ") {
        oldLeft -= 1;
        newLeft -= 1;
      } else if (kind === "-") oldLeft -= 1;
      else if (kind === "+") newLeft -= 1;
      else if (kind === "\\") {
        current.skip ??= "a file without a final newline";
        continue;
      } else if (text === "" && index === lines.length - 1) break;
      else throw new Error(`the diff is malformed near line ${index + 1}`);
      parsed.lines.push({ kind, text: text.slice(1) });
    }
    // A following "\ No newline" marker belongs to this hunk.
    if (lines[index + 1]?.startsWith("\\")) {
      current.skip ??= "a file without a final newline";
      index += 1;
    }
    current.hunks.push(parsed);
  }
  return files;
}

/** The changed regions of a parsed hunk, each with the context lines directly around it. */
function regionsOf(hunk: ParsedHunk): RecipeHunk[] {
  const regions: RecipeHunk[] = [];
  const { lines } = hunk;
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.kind === " ") {
      index += 1;
      continue;
    }
    const start = index;
    const remove: string[] = [];
    const add: string[] = [];
    while (index < lines.length && lines[index]!.kind !== " ") {
      (lines[index]!.kind === "-" ? remove : add).push(lines[index]!.text);
      index += 1;
    }
    const before: string[] = [];
    for (let back = start - 1; back >= 0 && lines[back]!.kind === " "; back -= 1)
      before.unshift(lines[back]!.text);
    const after: string[] = [];
    for (let forward = index; forward < lines.length && lines[forward]!.kind === " "; forward += 1)
      after.push(lines[forward]!.text);
    regions.push({ before, remove, add, after });
  }
  return regions;
}

/** Build a recipe from a repair's diff. Throws when there is no project source change to capture. */
export function captureRecipe(input: CaptureInput): CaptureResult {
  const skipped: CaptureResult["skipped"] = [];
  const hunks: RecipeHunk[] = [];
  const seen = new Set<string>();

  for (const file of parseDiff(input.diff)) {
    if (!input.isSource(file.path)) {
      // Dependency files change through the upgrade itself; they are not part of what was learned.
      if (file.hunks.length > 0 || file.skip)
        skipped.push({ file: file.path, reason: "not project source" });
      continue;
    }
    if (file.skip) {
      skipped.push({ file: file.path, reason: file.skip });
      continue;
    }
    for (const hunk of file.hunks) {
      for (const region of regionsOf(hunk)) {
        const key = JSON.stringify([region.before, region.remove, region.add, region.after]);
        if (seen.has(key)) continue;
        seen.add(key);
        hunks.push(region);
      }
    }
  }
  if (hunks.length === 0)
    throw new Error("the repair changed no project source that a recipe can describe");

  const candidate = {
    schemaVersion: RECIPE_SCHEMA_VERSION,
    package: input.packageName,
    fromRange: input.fromRange,
    toRange: input.toRange,
    observed: { fromVersion: input.fromVersion, toVersion: input.toVersion },
    ...(input.summary ? { summary: input.summary.slice(0, 500) } : {}),
    breaking: input.breaking ?? [],
    hunks,
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
  const parsed = recipeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `the repair cannot be expressed as a recipe: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  return { recipe: parsed.data, skipped };
}

/** A range covering the version's major (or minor, below 1.0), starting at the version itself. */
export function rangeAround(version: string): string | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return undefined;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 0 ? `>=${version} <${major + 1}.0.0` : `>=${version} <0.${minor + 1}.0`;
}
