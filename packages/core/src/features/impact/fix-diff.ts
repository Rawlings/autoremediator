/**
 * Fix-diff vulnerable symbols.
 *
 * Compare a vulnerable version of a package with the version that fixes it and list the exports
 * whose implementation changed. This is a HEURISTIC: a vulnerability fix changes the vulnerable
 * code, but a changed export is not proof it was the vulnerable one (refactors, helper changes and
 * unrelated fixes shipped in the same release show up too). Candidates are ranked, and when an
 * advisory text or CWE ids are given, by how closely the change matches them. Nothing here is
 * looked up or invented: every reason comes from the two versions' code or the text provided.
 */
import { basename } from "node:path";

import type { LocalDef } from "./js-exports.js";
import { PackageIndex, specifierFor, type ResolvedExport } from "./package-index.js";
import type { PackageSource } from "./types.js";

export interface AdvisoryHints {
  /** Advisory summary and details, as free text. */
  text?: string;
  /** CWE identifiers (`CWE-1333` or `1333`). */
  cwes?: string[];
}

export type CandidateBasis =
  | "direct"
  | "removed-in-fix"
  | "via-internal-function"
  | "via-internal-module";

export interface VulnerableSymbolCandidate {
  /** Name to look for in project code (for a default export of a deep file, the file's name). */
  symbol: string;
  /** The export it is, `default` and `module.exports` included. */
  exportName: string;
  /** Import specifier that reaches it, e.g. `lodash` or `lodash/template`. */
  specifier: string;
  /** Other specifiers that reach the same definition. */
  alsoImportableAs?: string[];
  /** Defining file in the fixed version (the vulnerable version for a removed export). */
  file: string;
  kind: "function" | "class" | "value" | "module";
  basis: CandidateBasis;
  /** Changed internal functions or modules this export depends on (not for `direct`). */
  via: string[];
  score: number;
  /** Why it ranks where it does, one entry per contribution to the score. */
  reasons: string[];
  /** Identifiers and literals added by the fix and removed by it, most informative first. */
  addedTokens: string[];
  removedTokens: string[];
}

export interface ChangedInternal {
  file: string;
  name: string;
  change: "changed" | "added" | "removed";
}

export interface FixDiff {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  /** Always true: the result is a heuristic, not a determination. */
  heuristic: true;
  candidates: VulnerableSymbolCandidate[];
  totalCandidates: number;
  /** Exports present only in the fixed version. */
  addedExports: string[];
  /** Files whose normalised content differs (formatting and comments ignored). */
  changedFiles: Array<{ file: string; change: "modified" | "added" | "removed" }>;
  /** Named internal definitions that changed and could not be tied to an export. */
  changedInternals: ChangedInternal[];
  /** What this analysis could not see, so a reader can judge a weak result. */
  limitations: string[];
}

export interface FindOptions {
  hints?: AdvisoryHints;
  /** Largest number of candidates returned (default 25). */
  limit?: number;
}

const DEFAULT_LIMIT = 25;
const MAX_DEEP_FILES = 1500;
const MAX_VIA_DEPTH = 4;
const SKIPPED_DIRECTORIES =
  /(^|\/)(test|tests|__tests__|spec|specs|fixtures|examples?|docs?|benchmarks?|scripts)\//;

interface PublicModule {
  specifier: string;
  file: string;
}

/** Modules a consumer can import, keyed by specifier. */
export function publicModules(index: PackageIndex): PublicModule[] {
  const manifestName = index.source.manifest.name;
  const name = typeof manifestName === "string" ? manifestName : index.source.name;
  const modules = new Map<string, PublicModule>();
  for (const entry of index.entries) {
    if (entry.file)
      modules.set(specifierFor(name, entry.subpath), {
        specifier: specifierFor(name, entry.subpath),
        file: entry.file,
      });
  }
  const hasExportsMap =
    index.source.manifest.exports !== undefined && index.source.manifest.exports !== null;
  if (!hasExportsMap) {
    const covered = new Set([...modules.values()].map((module) => module.file));
    let count = 0;
    for (const file of index.source.files.keys()) {
      if (covered.has(file) || /\.d\.[cm]?ts$/.test(file) || SKIPPED_DIRECTORIES.test(file))
        continue;
      if (++count > MAX_DEEP_FILES) break;
      const stripped = file.replace(/\.[cm]?[jt]sx?$/, "");
      modules.set(`${name}/${stripped}`, { specifier: `${name}/${stripped}`, file });
    }
  }
  return [...modules.values()].toSorted((a, b) => a.specifier.localeCompare(b.specifier));
}

interface LocalChange {
  change: "changed" | "added" | "removed";
  oldDef?: LocalDef;
  newDef?: LocalDef;
}

function tokenDelta(
  oldTokens: Set<string>,
  newTokens: Set<string>,
): { added: string[]; removed: string[] } {
  return {
    added: [...newTokens].filter((token) => !oldTokens.has(token)).toSorted(),
    removed: [...oldTokens].filter((token) => !newTokens.has(token)).toSorted(),
  };
}

/** CWE id -> predicate over a token (identifier or literal) that suggests the fix touches that class. */
interface CweHint {
  ids: readonly number[];
  label: string;
  matches(token: string): boolean;
}

const REGEX_LITERAL = /^\/.+\/[a-z]*$/s;

/**
 * Small static table of vocabulary typical of fixes for common weakness classes. It only decides
 * how a candidate is ranked, and every use is reported in `reasons`.
 */
export const CWE_HINTS: readonly CweHint[] = [
  {
    ids: [1333, 185, 186, 400, 405, 770, 407],
    label: "regular expression or size limit",
    matches: (token) =>
      REGEX_LITERAL.test(token) || /^(regexp|limit|max\w*|timeout|length)$/i.test(token),
  },
  {
    ids: [77, 78, 88, 74],
    label: "command construction or escaping",
    matches: (token) =>
      /^(exec|execsync|spawn|spawnsync|shell|escape\w*|quote\w*|sanitize\w*)$/i.test(token),
  },
  {
    ids: [22, 23, 36, 73, 59],
    label: "path handling",
    matches: (token) =>
      /^(resolve|normalize|relative|isabsolute|basename|sep)$/i.test(token) ||
      token === ".." ||
      token.includes("../"),
  },
  {
    ids: [1321, 915, 471],
    label: "prototype or own-property handling",
    matches: (token) =>
      /^(__proto__|constructor|prototype|hasownproperty|issafekey\w*)$/i.test(token),
  },
  {
    ids: [79, 80, 116, 83],
    label: "output escaping",
    matches: (token) =>
      /^(escape\w*|sanitize\w*|encode\w*|htmlentities)$/i.test(token) ||
      /^&(amp|lt|gt|quot);?$/.test(token),
  },
  {
    ids: [94, 95, 96, 917, 1336],
    label: "dynamic code or identifier validation",
    matches: (token) =>
      /^(eval|function|runinnewcontext|runinthiscontext)$/i.test(token) ||
      /(forbidden|unsafe|illegal|invalid)/i.test(token),
  },
  {
    ids: [20, 1284, 129, 190, 191],
    label: "input validation",
    matches: (token) =>
      /^(typeof|isfinite|isnan|isinteger|validate\w*|assert\w*|typeerror|rangeerror)$/i.test(token),
  },
  {
    ids: [601, 918, 441],
    label: "URL or host validation",
    matches: (token) => /^(url|hostname|host|origin|protocol|localhost)$/i.test(token),
  },
  {
    ids: [347, 295, 297, 327, 328, 330, 338],
    label: "signature or cryptography",
    matches: (token) =>
      /^(verify|signature|algorithms?|alg|random\w*|createhash|timingsafeequal)$/i.test(token),
  },
];

/** Parse `CWE-123`, `cwe 123` and bare numbers. */
export function parseCweIds(
  values: readonly string[] | undefined,
  text: string | undefined,
): number[] {
  const ids = new Set<number>();
  for (const value of values ?? []) {
    const match = /(\d+)/.exec(value);
    if (match?.[1]) ids.add(Number.parseInt(match[1], 10));
  }
  for (const match of (text ?? "").matchAll(/CWE[-\s:]*(\d{1,5})/gi)) {
    if (match[1]) ids.add(Number.parseInt(match[1], 10));
  }
  return [...ids].toSorted((a, b) => a - b);
}

const STOP_WORDS = new Set([
  "default",
  "module",
  "exports",
  "function",
  "string",
  "object",
  "value",
  "values",
  "error",
  "version",
  "package",
  "before",
  "after",
  "which",
  "where",
  "when",
  "this",
  "that",
  "with",
  "from",
  "into",
  "have",
  "does",
  "allows",
  "allow",
  "attacker",
  "attackers",
  "remote",
  "arbitrary",
  "vulnerable",
  "vulnerability",
  "affected",
  "fixed",
  "issue",
  "input",
  "could",
  "would",
  "should",
  "using",
  "used",
  "uses",
  "cause",
  "causes",
]);

function wordsOf(text: string): Set<string> {
  return new Set([...text.toLowerCase().matchAll(/[a-z_$][\w$]*/g)].map((match) => match[0]));
}

function scoreCandidate(
  candidate: Omit<VulnerableSymbolCandidate, "score" | "reasons">,
  depth: number,
  hints: AdvisoryHints | undefined,
  hintWords: Set<string>,
  cweIds: number[],
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string): void => {
    score += points;
    reasons.push(`${points >= 0 ? "+" : ""}${points} ${reason}`);
  };

  switch (candidate.basis) {
    case "direct": {
      if (candidate.kind === "value") add(40, "an exported value (not a function) changed");
      else add(100, "the export's own implementation changed");
      break;
    }
    case "removed-in-fix": {
      add(55, "the export was removed in the fixed version");
      break;
    }
    case "via-internal-function": {
      add(
        Math.max(15, 40 - 8 * (depth - 1)),
        `depends on changed internal function ${candidate.via.join(", ")} (${depth} call hop${depth === 1 ? "" : "s"} away)`,
      );
      break;
    }
    case "via-internal-module": {
      add(20, `its module imports changed module ${candidate.via.join(", ")}`);
      break;
    }
  }

  const size = candidate.addedTokens.length + candidate.removedTokens.length;
  if (candidate.basis === "direct" && size > 0) {
    const bonus = Math.max(0, 10 - Math.floor(Math.log2(1 + size)));
    if (bonus > 0) add(bonus, `small change (${size} identifiers or literals differ)`);
  }

  if (hints?.text) {
    const plain = candidate.symbol;
    if (
      plain.length >= 3 &&
      !STOP_WORDS.has(plain.toLowerCase()) &&
      new RegExp(String.raw`(?<![\w$])${plain.replaceAll(/[$]/g, String.raw`\$`)}(?![\w$])`).test(
        hints.text,
      )
    ) {
      add(60, `\`${plain}\` is named in the advisory text`);
    }
    const overlap = candidate.addedTokens
      .filter(
        (token) =>
          /^[A-Za-z_$][\w$]{3,}$/.test(token) &&
          !STOP_WORDS.has(token.toLowerCase()) &&
          hintWords.has(token.toLowerCase()),
      )
      .slice(0, 3);
    if (overlap.length > 0)
      add(
        10 * overlap.length,
        `fix adds ${overlap.map((token) => `\`${token}\``).join(", ")}, which the advisory text mentions`,
      );
  }

  if (cweIds.length > 0) {
    const matchedLabels: string[] = [];
    const matchedTokens = new Set<string>();
    for (const hint of CWE_HINTS) {
      if (!hint.ids.some((id) => cweIds.includes(id))) continue;
      const matches = candidate.addedTokens.filter((token) => hint.matches(token));
      if (matches.length > 0) {
        matchedLabels.push(hint.label);
        for (const token of matches.slice(0, 3)) matchedTokens.add(token);
      }
    }
    if (matchedTokens.size > 0) {
      add(
        Math.min(48, 12 * matchedTokens.size),
        `fix adds ${[...matchedTokens].map((token) => `\`${token}\``).join(", ")}, typical of ${matchedLabels.join(" and ")} (CWE ${cweIds.join(", ")})`,
      );
    }
  }
  return { score, reasons };
}

function topTokens(tokens: string[]): string[] {
  // Longer, identifier-like tokens first: they say more than punctuation-sized literals.
  return tokens.toSorted((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 12);
}

/** Compare two versions of a package and rank the exports the fix changed. */
export function findVulnerableSymbols(
  vulnerable: PackageSource,
  fixed: PackageSource,
  options: FindOptions = {},
): FixDiff {
  const oldIndex = new PackageIndex(vulnerable);
  const newIndex = new PackageIndex(fixed);
  const hints = options.hints;
  const hintWords = wordsOf(hints?.text ?? "");
  const cweIds = parseCweIds(hints?.cwes, hints?.text);
  const limitations: string[] = [
    "Heuristic: a changed export is a candidate, not proof it was the vulnerable one.",
    "Static analysis of JavaScript source only; dynamically built exports, native addons and WebAssembly are not seen.",
  ];

  const changedLocalsCache = new Map<string, Map<string, LocalChange>>();
  const changedLocalsOf = (
    oldFile: string | undefined,
    newFile: string | undefined,
  ): Map<string, LocalChange> => {
    const key = `${oldFile ?? ""}|${newFile ?? ""}`;
    const cached = changedLocalsCache.get(key);
    if (cached) return cached;
    const result = new Map<string, LocalChange>();
    const oldLocals =
      (oldFile ? oldIndex.module(oldFile) : undefined)?.locals ?? new Map<string, LocalDef>();
    const newLocals =
      (newFile ? newIndex.module(newFile) : undefined)?.locals ?? new Map<string, LocalDef>();
    for (const [name, def] of newLocals) {
      const previous = oldLocals.get(name);
      if (!previous) result.set(name, { change: "added", newDef: def });
      else if (previous.fingerprint !== def.fingerprint)
        result.set(name, { change: "changed", oldDef: previous, newDef: def });
    }
    for (const [name, def] of oldLocals) {
      if (!newLocals.has(name)) result.set(name, { change: "removed", oldDef: def });
    }
    changedLocalsCache.set(key, result);
    return result;
  };

  const oldModules = new Map(publicModules(oldIndex).map((module) => [module.specifier, module]));
  const newModules = new Map(publicModules(newIndex).map((module) => [module.specifier, module]));
  const specifiers = [...new Set([...oldModules.keys(), ...newModules.keys()])].toSorted();

  const candidates: VulnerableSymbolCandidate[] = [];
  const addedExports: string[] = [];
  const seenInternals = new Set<string>();
  const explainedInternals = new Set<string>();
  let weakDiscovery = false;

  for (const specifier of specifiers) {
    const oldModule = oldModules.get(specifier);
    const newModule = newModules.get(specifier);
    const oldExports = oldModule
      ? oldIndex.exportsOf(oldModule.file)
      : new Map<string, ResolvedExport>();
    const newExports = newModule
      ? newIndex.exportsOf(newModule.file)
      : new Map<string, ResolvedExport>();
    if (newModule && newIndex.module(newModule.file)?.discovery === "namespace-assignments")
      weakDiscovery = true;

    const symbolFor = (exportName: string, file: string): string =>
      (exportName === "default" || exportName === "module.exports") && specifier.includes("/")
        ? basename(file).replace(/\.[cm]?[jt]sx?$/, "")
        : exportName;

    for (const exportName of [
      ...new Set([...oldExports.keys(), ...newExports.keys()]),
    ].toSorted()) {
      const before = oldExports.get(exportName);
      const after = newExports.get(exportName);
      if (!after) {
        if (!before) continue;
        const base = {
          symbol: symbolFor(exportName, before.definedIn),
          exportName,
          specifier,
          file: before.definedIn,
          kind: before.kind,
          basis: "removed-in-fix" as const,
          via: [] as string[],
          addedTokens: [] as string[],
          removedTokens: topTokens([...before.tokens]),
        };
        const { score, reasons } = scoreCandidate(base, 0, hints, hintWords, cweIds);
        candidates.push({ ...base, score, reasons });
        continue;
      }
      if (!before) {
        addedExports.push(
          `${specifier}${exportName === "default" || exportName === "module.exports" ? "" : `#${exportName}`}`,
        );
        continue;
      }

      const localChanges = changedLocalsOf(before.definedIn, after.definedIn);
      let basis: CandidateBasis | undefined;
      let depth = 0;
      const via: string[] = [];
      let delta = { added: [] as string[], removed: [] as string[] };

      if (before.fingerprint !== after.fingerprint) {
        if (after.kind === "module") {
          // `exports.x = require("./x")`: it is the required module that changed.
          basis = "via-internal-module";
          via.push(after.moduleRef ?? after.definedIn);
        } else {
          basis = "direct";
          delta = tokenDelta(before.tokens, after.tokens);
          if (after.local) explainedInternals.add(`${after.definedIn}#${after.local}`);
          const changedTokens = [...delta.added, ...delta.removed];
          // A bumped version constant is not a fix.
          if (
            changedTokens.length > 0 &&
            changedTokens.every((token) => /^\d+\.\d+\.\d+/.test(token))
          )
            continue;
        }
      } else {
        // Breadth-first through the definitions this export refers to, in its own module.
        const newMod = newIndex.module(after.definedIn);
        const visited = new Set<string>();
        let frontier = [...after.refs].filter((ref) => newMod?.locals.has(ref));
        for (let level = 1; level <= MAX_VIA_DEPTH && frontier.length > 0 && !basis; level++) {
          const next: string[] = [];
          const hits: string[] = [];
          for (const name of frontier.toSorted()) {
            if (visited.has(name)) continue;
            visited.add(name);
            if (localChanges.has(name)) hits.push(name);
            const def = newMod?.locals.get(name);
            if (def)
              for (const ref of def.refs)
                if (newMod?.locals.has(ref) && !visited.has(ref)) next.push(ref);
          }
          if (hits.length > 0) {
            basis = "via-internal-function";
            depth = level;
            via.push(...hits.slice(0, 3));
            for (const name of hits) {
              explainedInternals.add(`${after.definedIn}#${name}`);
              const change = localChanges.get(name);
              if (change) {
                const part = tokenDelta(
                  change.oldDef?.tokens ?? new Set(),
                  change.newDef?.tokens ?? new Set(),
                );
                delta = {
                  added: [...delta.added, ...part.added],
                  removed: [...delta.removed, ...part.removed],
                };
              }
            }
          }
          frontier = next;
        }
        if (!basis) {
          const newMod2 = newIndex.module(after.definedIn);
          const oldMod2 = oldIndex.module(before.definedIn);
          for (const relative of newMod2?.relativeImports ?? []) {
            const newTarget = newIndex.resolveRelative(after.definedIn, relative);
            const oldTarget = oldIndex.resolveRelative(before.definedIn, relative);
            if (!newTarget || !oldTarget) continue;
            if (
              oldIndex.module(oldTarget)?.fingerprint !== newIndex.module(newTarget)?.fingerprint &&
              oldMod2
            ) {
              basis = "via-internal-module";
              via.push(newTarget);
              break;
            }
          }
        }
      }
      if (!basis) continue;

      const base = {
        symbol: symbolFor(exportName, after.definedIn),
        exportName,
        specifier,
        file: after.definedIn,
        kind: after.kind,
        basis,
        via,
        addedTokens: topTokens([...new Set(delta.added)]),
        removedTokens: topTokens([...new Set(delta.removed)]),
      };
      const { score, reasons } = scoreCandidate(base, depth, hints, hintWords, cweIds);
      candidates.push({ ...base, score, reasons });
    }
  }

  // One entry per definition: the same export reached through several specifiers (`lodash` and
  // `lodash/index`) is listed once, under the shortest specifier.
  const byDefinition = new Map<string, VulnerableSymbolCandidate>();
  for (const candidate of candidates.toSorted(
    (a, b) => a.specifier.length - b.specifier.length || a.specifier.localeCompare(b.specifier),
  )) {
    const key = `${candidate.file}|${candidate.exportName}|${candidate.basis}`;
    const existing = byDefinition.get(key);
    if (existing) {
      existing.alsoImportableAs = [...(existing.alsoImportableAs ?? []), candidate.specifier];
      // A deep specifier names the file, which says more than `default` does.
      if (existing.symbol === existing.exportName && candidate.symbol !== candidate.exportName) {
        existing.symbol = candidate.symbol;
      }
    } else {
      byDefinition.set(key, { ...candidate });
    }
  }
  const ranked = [...byDefinition.values()].toSorted(
    (a, b) =>
      b.score - a.score ||
      a.specifier.localeCompare(b.specifier) ||
      a.symbol.localeCompare(b.symbol),
  );

  // Changed definitions no export could be tied to (and files that differ at all).
  const changedInternals: ChangedInternal[] = [];
  const changedFiles: FixDiff["changedFiles"] = [];
  const allFiles = [...new Set([...vulnerable.files.keys(), ...fixed.files.keys()])]
    .filter((file) => !/\.d\.[cm]?ts$/.test(file))
    .toSorted();
  for (const file of allFiles) {
    const inOld = vulnerable.files.has(file);
    const inNew = fixed.files.has(file);
    if (inOld && inNew) {
      const oldMod = oldIndex.module(file);
      const newMod = newIndex.module(file);
      const differs =
        oldMod && newMod
          ? oldMod.fingerprint !== newMod.fingerprint
          : vulnerable.files.get(file) !== fixed.files.get(file);
      if (!differs) continue;
      changedFiles.push({ file, change: "modified" });
      for (const [name, change] of changedLocalsOf(file, file)) {
        const key = `${file}#${name}`;
        if (explainedInternals.has(key) || seenInternals.has(key)) continue;
        seenInternals.add(key);
        changedInternals.push({ file, name, change: change.change });
      }
    } else {
      changedFiles.push({ file, change: inNew ? "added" : "removed" });
    }
  }

  if (weakDiscovery) {
    limitations.push(
      "A bundle's exports were found by a namespace-assignment heuristic (`ns.name = fn`), so some exports may be missed or mis-attributed.",
    );
  }
  if (!vulnerable.integrityVerified || !fixed.integrityVerified) {
    limitations.push("At least one tarball had no registry digest to verify against.");
  }
  if (candidates.length === 0) {
    limitations.push(
      changedFiles.length === 0
        ? "The two versions' code is identical after normalising formatting and comments."
        : "Code changed, but no export could be tied to the change; see changedInternals.",
    );
  }

  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  return {
    packageName: fixed.name,
    fromVersion: vulnerable.version,
    toVersion: fixed.version,
    heuristic: true,
    candidates: ranked.slice(0, limit),
    totalCandidates: ranked.length,
    addedExports: addedExports.toSorted().slice(0, 100),
    changedFiles: changedFiles.slice(0, 200),
    changedInternals: changedInternals.slice(0, 100),
    limitations,
  };
}
