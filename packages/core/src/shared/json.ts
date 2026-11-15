/**
 * JSON at the boundary: text that came from disk, the network or a caller is `unknown` until a
 * schema has parsed it. Use these instead of `JSON.parse(text) as T`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ZodType } from "zod";

import { DataFormatError, errorMessage } from "./errors.js";

/**
 * Parses `text` against `schema`. `source` names where the text came from (a path, a URL) so a
 * failure says which file or response was damaged and which field is wrong.
 */
export function parseJson<T>(text: string, schema: ZodType<T>, source: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DataFormatError(`${source} is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new DataFormatError(
      `${source} is not in the expected format${where}: ${issue?.message}`,
      {
        cause: parsed.error,
      },
    );
  }
  return parsed.data;
}

/** Reads and parses a JSON file. Synchronous: for CLI start-up and small local state. */
export function readJsonFileSync<T>(path: string, schema: ZodType<T>): T {
  return parseJson(readFileSync(path, "utf8"), schema, path);
}

/** Reads and parses a JSON file. */
export async function readJsonFile<T>(path: string, schema: ZodType<T>): Promise<T> {
  return parseJson(await readFile(path, "utf8"), schema, path);
}

/** Writes JSON through a temporary file and a rename, so a reader never sees half a file. */
export function writeJsonFileSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}
