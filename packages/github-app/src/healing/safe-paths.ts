import { posix } from "node:path";

/**
 * Paths a repair may write to. File paths come out of CI logs, which anyone who can run a workflow
 * (or publish a dependency whose install script prints text) can influence, so a path is accepted
 * only if it is an ordinary, repository-relative source file.
 */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

const MAX_PATH_LENGTH = 300;

/** Why a path may not be repaired, or `undefined` when it may. */
export function repairPathProblem(filePath: string): string | undefined {
  if (filePath.length === 0 || filePath.length > MAX_PATH_LENGTH) return "path length";
  if (filePath.includes("\0") || filePath.includes("\\")) return "unsupported characters";
  if (posix.isAbsolute(filePath)) return "absolute path";

  const normalized = posix.normalize(filePath);
  const segments = normalized.split("/");
  if (segments.includes("..") || normalized === ".") return "outside the repository";

  const name = segments.at(-1) ?? "";
  const lowerName = name.toLowerCase();

  if (segments.includes(".git") || segments.includes("node_modules")) return "not a source file";
  if (normalized.toLowerCase().startsWith(".github/")) {
    return "workflow, policy or repository configuration";
  }
  if (LOCKFILES.has(lowerName)) return "lockfile";
  if (lowerName.startsWith(".autoremediator") || lowerName.startsWith("autoremediator.policy.")) {
    return "autoremediator policy";
  }
  if (lowerName === "package.json") return "dependency manifest";
  if (!SOURCE_EXTENSIONS.has(posix.extname(lowerName))) return "not a source file";
  return undefined;
}

export function isRepairablePath(filePath: string): boolean {
  return repairPathProblem(filePath) === undefined;
}
