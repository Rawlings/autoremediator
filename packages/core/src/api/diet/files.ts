import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

/** Files the AST scanner parses. */
export const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);
/** Templates and single-file components: not parsed, but searched for quoted package names. */
const TEMPLATE_EXTENSIONS = new Set([
  ".vue",
  ".svelte",
  ".astro",
  ".mdx",
  ".html",
  ".ejs",
  ".hbs",
  ".pug",
]);
/** Directories that are never source, whatever .gitignore says. */
const ALWAYS_SKIPPED = new Set(["node_modules", ".git"]);
/** Generated-output directories: skipped only when .gitignore says they are not committed. */
const GENERATED_DIRECTORIES = new Set([
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vercel",
  ".pnpm-store",
  ".yarn",
  ".autoremediator",
  "target",
]);
/** Directories whose files are configuration or scripts even without an extension. */
const CONFIG_DIRECTORIES = new Set([
  ".github",
  ".husky",
  ".storybook",
  ".changeset",
  ".circleci",
  ".config",
  ".gitlab",
  ".buildkite",
]);
const SCRIPT_DIRECTORIES = new Set(["bin", "scripts", "tools", "script"]);

const MAX_PARSED_BYTES = 1_000_000;
const MAX_TEXT_BYTES = 1_000_000;

/** Tool configuration by file name, wherever it sits in the package. */
const CONFIG_NAME_PATTERNS: readonly RegExp[] = [
  /^\.[\w.-]*rc(\.(json|jsonc|json5|ya?ml|js|cjs|mjs|ts|cts|mts|toml))?$/i,
  /\.config\.(js|cjs|mjs|ts|cts|mts|json|jsonc|ya?ml|toml)$/i,
  /^(tsconfig|jsconfig)[\w.-]*\.json$/i,
  /^\.?pnpmfile\.c?js$/i,
  /^(Dockerfile|Makefile|Procfile|Jenkinsfile|justfile|Taskfile)[\w.-]*$/,
  /^\.(travis|gitlab-ci)\.ya?ml$/i,
  /^(azure-pipelines|bitbucket-pipelines|cloudbuild|netlify|vercel|wrangler|renovate|nx|turbo|lerna|rush)[\w.-]*\.(ya?ml|json|jsonc|toml)$/i,
  /^\.?(browserslistrc?|lintstagedrc|huskyrc|npmrc|yarnrc\.ya?ml)$/i,
  /^(babel|jest|vitest|vite|webpack|rollup|esbuild|tsup|tsdown|postcss|tailwind|eslint|prettier|stylelint|commitlint|lint-staged|release|karma|cypress|playwright|nodemon|ava|nyc|mocha|knip|depcheck)[\w.-]*\.(js|cjs|mjs|ts|cts|mts|json|ya?ml)$/i,
];

export type FileRole = "source" | "template" | "config" | "script";

export interface ScannedFile {
  absolute: string;
  /** Relative to the package directory, with forward slashes. */
  path: string;
  role: FileRole;
  /** Config files that are also JavaScript or TypeScript are parsed as well as tokenised. */
  parse: boolean;
}

export interface PackageFiles {
  files: ScannedFile[];
  /** Files too large to read. */
  skipped: string[];
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

/** Directory names a .gitignore at `directory` ignores by a plain name pattern. */
function ignoredByGitignore(directory: string): Set<string> {
  const ignored = new Set<string>();
  let text: string;
  try {
    text = readFileSync(join(directory, ".gitignore"), "utf8");
  } catch {
    return ignored;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const name = line
      .replace(/^\*\*\//, "")
      .replace(/^\//, "")
      .replace(/\/\*{0,2}$/, "");
    if (/^[\w.-]+$/.test(name)) ignored.add(name);
  }
  return ignored;
}

export function isConfigName(name: string): boolean {
  return CONFIG_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

function classify(
  name: string,
  inConfigDirectory: boolean,
  inScriptDirectory: boolean,
): FileRole | undefined {
  const extension = extname(name).toLowerCase();
  const isSource = SOURCE_EXTENSIONS.has(extension);
  if (
    isConfigName(name) ||
    (inConfigDirectory && /\.(ya?ml|json|jsonc|toml|sh|js|cjs|mjs|ts)$|^[^.]+$/.test(name))
  ) {
    return "config";
  }
  if (isSource) return "source";
  if (TEMPLATE_EXTENSIONS.has(extension)) return "template";
  if (inScriptDirectory && (extension === "" || extension === ".sh")) return "script";
  return undefined;
}

/**
 * Everything in a package directory that can name a dependency: source, templates, tool
 * configuration, CI and git hooks, scripts. Directories of other workspace packages are left to
 * their own analysis. Generated-output directories are skipped only when .gitignore says they are
 * not committed; otherwise they are scanned, because skipping real source would turn a used
 * dependency into a false `certainly-unused`.
 */
export function collectPackageFiles(
  packageDir: string,
  options: { excludeDirectories?: ReadonlySet<string>; gitignoreRoots?: readonly string[] } = {},
): PackageFiles {
  const ignoredGenerated = new Set<string>();
  for (const directory of [packageDir, ...(options.gitignoreRoots ?? [])]) {
    for (const name of ignoredByGitignore(directory)) {
      if (GENERATED_DIRECTORIES.has(name)) ignoredGenerated.add(name);
    }
  }

  const files: ScannedFile[] = [];
  const skipped: string[] = [];

  const visit = (directory: string, inConfig: boolean, inScripts: boolean): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries.toSorted()) {
      const absolute = join(directory, entry);
      if (ALWAYS_SKIPPED.has(entry) || ignoredGenerated.has(entry)) continue;
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (options.excludeDirectories?.has(absolute)) continue;
        visit(
          absolute,
          inConfig || CONFIG_DIRECTORIES.has(entry),
          inScripts || SCRIPT_DIRECTORIES.has(entry),
        );
        continue;
      }
      const role = classify(basename(entry), inConfig, inScripts);
      if (!role) continue;
      const path = toPosix(relative(packageDir, absolute));
      if (stats.size > MAX_TEXT_BYTES) {
        skipped.push(path);
        continue;
      }
      const extension = extname(entry).toLowerCase();
      const parse = SOURCE_EXTENSIONS.has(extension) && stats.size <= MAX_PARSED_BYTES;
      files.push({ absolute, path, role, parse });
    }
  };
  visit(packageDir, false, false);
  return { files, skipped };
}

export function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
