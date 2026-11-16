import JSON5 from "json5";
import { createMatchPath, loadConfig } from "tsconfig-paths";

/** A settings file written as JSON5: comments, unquoted keys and trailing commas are allowed. */
export function parseSettings(text: string): Record<string, unknown> {
  return JSON5.parse(text) as Record<string, unknown>;
}

/** Where an import alias from this project's tsconfig points, if the file exists. */
export function resolveAlias(cwd: string, alias: string): string | undefined {
  const config = loadConfig(`${cwd}/paths.tsconfig.json`);
  if (config.resultType !== "success") return undefined;
  return createMatchPath(config.absoluteBaseUrl, config.paths)(alias, undefined, undefined, [".ts"]);
}
