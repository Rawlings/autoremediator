/**
 * A cheap read of a reproduction script before it runs, and the reason a kept script can be
 * reviewed in seconds.
 *
 * This is a tripwire and a style rule, not a security boundary: it is bypassable by anyone who
 * writes code to bypass it. The boundary is the sandbox (`sandbox.ts`) the script runs in. The
 * screen exists because a kept script is committed to `patches/` and later run by the existing
 * proof-of-fix check in the project, outside that sandbox, so a script that has no business
 * touching the network, processes or the environment should be refused rather than kept.
 *
 * It also refuses the shortcuts a model takes when it is rewarded for "fails before, passes after":
 * looking at the package version, and reading the package's own files, instead of calling its API.
 */
import { parseSync } from "oxc-parser";

export const MAX_SCRIPT_CHARS = 20_000;

/** Modules a reproduction may load, besides the package under test. */
export const ALLOWED_BUILTINS: ReadonlySet<string> = new Set([
  "assert",
  "assert/strict",
  "buffer",
  "crypto",
  "events",
  "fs",
  "path",
  "querystring",
  "stream",
  "string_decoder",
  "timers",
  "url",
  "util",
  "zlib",
]);

export interface ScreenResult {
  ok: boolean;
  violations: string[];
}

/** `process` members a reproduction may use: finishing, and writing its verdict. Nothing that reads the environment. */
const ALLOWED_PROCESS_MEMBERS: ReadonlySet<string> = new Set([
  "exit",
  "exitCode",
  "stdout",
  "stderr",
  "nextTick",
  "on",
  "once",
  "emitWarning",
]);

/** Identifiers that reach code evaluation, globals, the network or the module system. */
const FORBIDDEN_IDENTIFIERS: Readonly<Record<string, string>> = {
  eval: "evaluates code built from strings",
  Function: "evaluates code built from strings",
  globalThis: "reaches globals indirectly",
  global: "reaches globals indirectly",
  fetch: "uses the network",
  XMLHttpRequest: "uses the network",
  WebSocket: "uses the network",
  EventSource: "uses the network",
  Worker: "starts another thread",
  module: "reaches the module system (module.*)",
  exports: "reaches the module system (exports)",
  __dirname: "looks at where it runs (the script must call the package, not its own location)",
  __filename: "looks at where it runs (the script must call the package, not its own location)",
  Reflect: "reaches objects indirectly",
  Proxy: "wraps objects in ways that can hide behaviour",
};

/** Is `specifier` a module the script may load: a listed builtin, or the package under test? */
function allowedSpecifier(specifier: string, packageName: string): boolean {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (ALLOWED_BUILTINS.has(bare)) return true;
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

type Node = { type: string; [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** The literal string a `require`/`import()` argument is, or undefined when it is computed. */
function literalString(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    const expressions = node.expressions as unknown[];
    const quasis = node.quasis as Array<{ value?: { cooked?: string } }>;
    if (expressions.length === 0 && quasis.length === 1) return quasis[0]?.value?.cooked;
  }
  return undefined;
}

interface Walk {
  specifiers: string[];
  violations: Set<string>;
}

function visit(node: Node, walk: Walk, parent?: Node): void {
  switch (node.type) {
    case "Identifier": {
      const name = node.name as string;
      const why = FORBIDDEN_IDENTIFIERS[name];
      if (why) walk.violations.add(`${name}: ${why}`);
      if (name === "require")
        walk.violations.add("uses `require` other than by calling it with a literal module name");
      if (name === "process")
        walk.violations.add("uses `process` other than exit, exitCode, stdout, stderr or nextTick");
      return;
    }
    case "MetaProperty": {
      walk.violations.add("looks at where it runs (import.meta)");
      return;
    }
    case "Literal": {
      if (typeof node.value === "string") {
        if (/\bpackage\.json\b/.test(node.value)) {
          walk.violations.add(
            "reads the package manifest (the script must call the package, not look at its version)",
          );
        }
        if (node.value === "version" || node.value === "versions") {
          walk.violations.add(
            "reads a version (the script must call the package, not look at its version)",
          );
        }
      }
      return;
    }
    case "MemberExpression": {
      const object = node.object;
      const property = node.property;
      const computed = node.computed === true;
      if (!computed && isNode(property) && property.type === "Identifier") {
        const name = property.name as string;
        if (name === "version" || name === "versions") {
          walk.violations.add(
            "reads a version (the script must call the package, not look at its version)",
          );
        }
        if (name === "constructor")
          walk.violations.add("reaches the Function constructor through `.constructor`");
      }
      if (isNode(object) && object.type === "Identifier" && object.name === "process") {
        if (
          computed ||
          !isNode(property) ||
          property.type !== "Identifier" ||
          !ALLOWED_PROCESS_MEMBERS.has(property.name as string)
        ) {
          const used =
            !computed && isNode(property) && property.type === "Identifier"
              ? `process.${String(property.name)}`
              : "process[...]";
          walk.violations.add(
            `${used}: uses a process API the script has no need for (environment, signals, version, directory)`,
          );
        }
        if (computed) visit(property as Node, walk, node);
        return;
      }
      visit(object as Node, walk, node);
      if (computed && isNode(property)) visit(property, walk, node);
      return;
    }
    case "CallExpression": {
      const callee = node.callee;
      if (isNode(callee) && callee.type === "Identifier" && callee.name === "require") {
        const args = node.arguments as unknown[];
        const specifier = literalString(args[0]);
        if (specifier === undefined || args.length !== 1)
          walk.violations.add("loads a module by a computed name");
        else walk.specifiers.push(specifier);
        for (const arg of args)
          if (isNode(arg) && literalString(arg) === undefined) visit(arg, walk, node);
        return;
      }
      break;
    }
    case "ImportExpression": {
      const specifier = literalString(node.source);
      if (specifier === undefined) walk.violations.add("loads a module by a computed name");
      else walk.specifiers.push(specifier);
      return;
    }
    case "ImportDeclaration":
    case "ExportAllDeclaration":
    case "ExportNamedDeclaration": {
      const specifier = literalString(node.source);
      if (specifier !== undefined) walk.specifiers.push(specifier);
      if (node.type === "ImportDeclaration") return;
      break;
    }
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition": {
      // A plain key (`{ process: 1 }`, `a.process`) is a name, not a reference.
      for (const [key, value] of Object.entries(node)) {
        if (key === "key" && node.computed !== true) continue;
        visitValue(value, walk, node);
      }
      return;
    }
    default: {
      break;
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "range" || key === "loc") continue;
    visitValue(value, walk, node);
  }
  void parent;
}

function visitValue(value: unknown, walk: Walk, parent: Node): void {
  if (Array.isArray(value)) {
    for (const entry of value) if (isNode(entry)) visit(entry, walk, parent);
  } else if (isNode(value)) {
    visit(value, walk, parent);
  }
}

/**
 * Read a script's syntax tree and refuse what a reproduction has no business doing. Everything is an
 * allowlist: only literal module names, only a few `process` members, no evaluation, no globals.
 * A computed name or an indirect route is refused rather than analysed.
 */
export function screenScript(
  script: string,
  context: { packageName: string; versions: readonly string[] },
): ScreenResult {
  const violations = new Set<string>();
  if (script.trim() === "") return { ok: false, violations: ["the script is empty"] };
  if (script.length > MAX_SCRIPT_CHARS) {
    violations.add(`the script is longer than ${MAX_SCRIPT_CHARS} characters`);
  }
  if (script.includes("\0")) violations.add("the script contains a NUL byte");
  if (violations.size > 0) return { ok: false, violations: [...violations] };

  let program: Node | undefined;
  try {
    const result = parseSync("reproduction.mjs", script, { preserveParens: false });
    if (result.errors.length > 0) {
      return { ok: false, violations: ["the script does not parse as JavaScript"] };
    }
    program = result.program as unknown as Node;
  } catch {
    return { ok: false, violations: ["the script does not parse as JavaScript"] };
  }

  const walk: Walk = { specifiers: [], violations };
  visit(program, walk);

  for (const specifier of new Set(walk.specifiers)) {
    if (/\bpackage\.json\b/.test(specifier)) {
      violations.add(
        "reads the package manifest (the script must call the package, not look at its version)",
      );
    }
    if (!allowedSpecifier(specifier, context.packageName)) {
      violations.add(
        `loads "${specifier}", which is not ${context.packageName} or one of: ${[...ALLOWED_BUILTINS].join(", ")}`,
      );
    }
  }
  if (
    !walk.specifiers.some(
      (specifier) =>
        specifier === context.packageName || specifier.startsWith(`${context.packageName}/`),
    )
  ) {
    violations.add(
      `never loads ${context.packageName}; a reproduction must exercise the package through its public API`,
    );
  }
  for (const version of context.versions) {
    if (script.includes(version)) {
      violations.add(
        `mentions the version ${version} (the script must behave differently because of the code, not because of a version it was told)`,
      );
    }
  }
  return { ok: violations.size === 0, violations: [...violations] };
}
