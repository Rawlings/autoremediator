import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the module at `moduleUrl` (pass `import.meta.url`) is the process entry script.
 *
 * Compares real paths so it also works when the script is launched through a symlink,
 * which is how npm/pnpm install package bins (`node_modules/.bin/<name>`).
 */
export function isEntrypoint(
  moduleUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
