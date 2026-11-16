import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resultFileSchema, type ResultFile } from "../results.ts";
import { MODE_NAMES } from "../task.ts";

export interface LoadedResult {
  file: string;
  result: ResultFile;
}

/**
 * The committed results: one file per mode, named `<mode>.json`, in the order the modes are listed.
 * A file whose name and mode disagree, or that does not match the schema, throws.
 */
export function loadResultFiles(dir: string): LoadedResult[] {
  const loaded = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((file) => {
      const parsed = resultFileSchema.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(file)"}: ${issue.message}`)
          .join("; ");
        throw new Error(`Malformed results file ${file}: ${issues}`);
      }
      if (file !== `${parsed.data.mode}.json`) {
        throw new Error(`Results file ${file} must be named ${parsed.data.mode}.json`);
      }
      return { file, result: parsed.data };
    });
  return loaded.toSorted(
    (a, b) => MODE_NAMES.indexOf(a.result.mode) - MODE_NAMES.indexOf(b.result.mode),
  );
}
