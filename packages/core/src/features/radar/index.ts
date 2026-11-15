/**
 * Silent-fix radar: for each dependency, compare the installed version with a newer one and flag
 * releases in between that look security-relevant, so the upgrade can happen before an advisory
 * exists. Signals are computed locally from the changelog, the code diff between the published
 * tarballs and registry metadata; an optional model adds a bounded classification. Every flag
 * carries its evidence. Radar never says a vulnerability exists: it reports a security-relevant
 * change without a published advisory, and cross-checks OSV for one.
 */
import semver from "semver";

import { errorMessage } from "../../shared/errors.js";
import { classifyUpgradeLevel } from "../intelligence/sources/registry.js";
import { resolveLanguageModel } from "../patch/model.js";
import { ByteBudgetExceeded, createByteBudget, createDefaultRadarDeps } from "./deps.js";
import { changelogFlags, parseChangelog } from "./signals/changelog.js";
import { codeDiffFlags, lineDiff } from "./signals/code-diff.js";
import { metadataFlags } from "./signals/metadata.js";
import { createLlmRadarClassifier, modelFlag, type RadarModelRequest } from "./signals/model.js";
import { sanitizeEvidence } from "./signals/sanitize.js";
import { scoreFlags } from "./signals/score.js";
import {
  CATEGORY_CAPS,
  CONFIDENCE_THRESHOLDS,
  RADAR_POINTS,
  SCORING_RULE,
  type RadarConfidence,
  type RadarFlag,
} from "./signals/types.js";
import type {
  ByteBudget,
  InstalledPackage,
  RadarAdvisory,
  RadarDeps,
  RadarEntry,
  RadarOptions,
  RadarPackage,
  RadarReport,
  RadarSkipped,
} from "./types.js";

export type {
  RadarAdvisory,
  RadarDeps,
  RadarEntry,
  RadarImpact,
  RadarOptions,
  RadarReport,
  RadarSkipped,
  RadarTarget,
} from "./types.js";
export type { RadarFlag, RadarCategory, RadarConfidence } from "./signals/types.js";
export type { RadarModelPort, RadarModelRequest, RadarModelVerdict } from "./signals/model.js";
export { createLlmRadarClassifier } from "./signals/model.js";
export { renderRadar, radarExitCode } from "./render.js";

export const RADAR_DISCLAIMER =
  "Radar reports security-relevant changes without a published advisory. It does not say that any vulnerability exists: " +
  "signals are heuristics read from changelog text, code differences and registry metadata, and each flag quotes its evidence " +
  "(untrusted text from the package) for a person to judge.";

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_PACKAGES = 100;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PACKAGE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
/** Releases diffed one by one up to this many; beyond it installed and target are diffed once. */
const MAX_STEPWISE_RELEASES = 5;
const MAX_ASSESSED = 5;
const MAX_LISTED_RELEASES = 100;

const CONFIDENCE_RANK: Record<RadarConfidence, number> = { likely: 0, possible: 1, weak: 2 };
const STATUS_RANK: Record<RadarEntry["status"], number> = {
  silent: 0,
  unchecked: 1,
  "now-advisory": 2,
};

function integerOption(
  name: string,
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

async function runPool<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R | undefined>({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results as R[];
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${Math.round(ms / 1000)}s (${what})`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The release to compare with, or undefined when the installed version is not behind it. */
export function pickTarget(
  installed: string,
  stable: readonly string[],
  latest: string | undefined,
  target: "latest" | "minor" | "patch",
): string | undefined {
  const newer = stable.filter((version) => semver.gt(version, installed));
  const candidates = newer.filter(
    (version) =>
      target === "latest" ||
      (semver.major(version) === semver.major(installed) &&
        (target === "minor" || semver.minor(version) === semver.minor(installed))),
  );
  if (target === "latest" && latest && candidates.includes(latest)) return latest;
  return candidates.toSorted((a, b) => semver.compare(a, b)).at(-1);
}

function repositoryOf(
  manifest: Record<string, unknown>,
): { owner: string; repo: string } | undefined {
  const raw = manifest["repository"];
  const url = typeof raw === "string" ? raw : (raw as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string") return undefined;
  const match =
    /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(url) ??
    /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(url) ??
    /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/.exec(url);
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : undefined;
}

interface Run {
  cwd: string;
  deps: RadarDeps;
  budget: ByteBudget;
  options: Required<Pick<RadarOptions, "target" | "github">> & { assess: boolean };
  assessRemaining: { count: number };
  notes: Set<string>;
}

type Outcome =
  | { kind: "entry"; entry: RadarEntry }
  | { kind: "clean" }
  | { kind: "up-to-date" }
  | { kind: "skipped"; skipped: RadarSkipped };

async function releaseNotesFlags(
  run: Run,
  installed: string,
  target: string,
  range: readonly string[],
  docs: ReadonlyMap<string, string>,
  repository: { owner: string; repo: string } | undefined,
): Promise<{ flags: RadarFlag[]; found: boolean; note?: string }> {
  // The tarball's own changelog: the document that covers the most releases in range.
  let best:
    | { name: string; sections: ReturnType<typeof parseChangelog>; covered: Set<string> }
    | undefined;
  for (const [name, text] of docs) {
    const sections = parseChangelog(text);
    const covered = new Set(
      sections
        .filter(
          (section) => semver.gt(section.version, installed) && semver.lte(section.version, target),
        )
        .map((section) => section.version),
    );
    if (covered.size > (best?.covered.size ?? 0)) best = { name, sections, covered };
  }
  const flags = best
    ? changelogFlags({
        source: sanitizeEvidence(best.name, 60),
        sections: best.sections,
        from: installed,
        to: target,
      })
    : [];
  let found = (best?.covered.size ?? 0) > 0;
  let note: string | undefined;

  const missing = range.filter((version) => !best?.covered.has(version));
  if (run.options.github && repository && missing.length > 0) {
    const fetched = await run.deps.fetchGithubReleases(repository);
    if (fetched.note) note = fetched.note;
    for (const release of fetched.releases) {
      const version = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag)?.[1];
      if (!version || !missing.includes(version)) continue;
      found = true;
      flags.push(
        ...changelogFlags({
          source: `github:${repository.owner}/${repository.repo}@${sanitizeEvidence(release.tag, 40)}`,
          sections: [
            {
              version,
              startLine: 0,
              lines: release.body
                .split(/\r?\n/)
                .slice(0, 400)
                .map((text, index) => ({ line: index + 1, text })),
            },
          ],
          from: installed,
          to: target,
        }),
      );
    }
  }
  return { flags, found, ...(note ? { note } : {}) };
}

async function analyse(run: Run, installed: InstalledPackage): Promise<Outcome> {
  const { deps, cwd, budget } = run;
  const registry = await deps.fetchVersions(installed.name, cwd, budget);
  if (!registry || registry.versions.length === 0) {
    return {
      kind: "skipped",
      skipped: {
        name: installed.name,
        version: installed.version,
        reason: "not found on the registry",
      },
    };
  }
  const stable = registry.versions.map((entry) => entry.version);
  const target = pickTarget(installed.version, stable, registry.latest, run.options.target);
  if (!target) return { kind: "up-to-date" };
  const range = stable
    .filter((version) => semver.gt(version, installed.version) && semver.lte(version, target))
    .toSorted((a, b) => semver.compare(a, b));
  const upgrade = classifyUpgradeLevel(installed.version, target);
  if (!upgrade) return { kind: "up-to-date" };

  const cache = new Map<string, Promise<RadarPackage>>();
  const load = (name: string, version: string): Promise<RadarPackage> => {
    const key = `${name}@${version}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = deps.loadPackage(name, version, cwd, budget);
    cache.set(key, pending);
    return pending;
  };

  const notes: string[] = [];
  if (registry.note) notes.push(registry.note);

  const chain =
    range.length <= MAX_STEPWISE_RELEASES
      ? [installed.version, ...range]
      : [installed.version, target];
  const diffMode: RadarEntry["diff"] =
    range.length <= MAX_STEPWISE_RELEASES ? "per-release" : "span";
  const packages: RadarPackage[] = [];
  for (const version of chain) packages.push(await load(installed.name, version));
  const before = packages[0]!;
  const after = packages.at(-1)!;

  const flags: RadarFlag[] = [];

  // 1. Changelog and release notes.
  const notesResult = await releaseNotesFlags(
    run,
    installed.version,
    target,
    range,
    after.docs,
    repositoryOf(after.manifest),
  );
  flags.push(...notesResult.flags);
  if (notesResult.note) run.notes.add(notesResult.note);
  if (!notesResult.found) {
    notes.push(
      run.options.github
        ? "no changelog for these releases in the package or on GitHub"
        : "no changelog for these releases in the package (pass github to read GitHub release notes)",
    );
  }

  // 2. Code differences, release by release when there are few.
  let filesChanged = 0;
  for (let index = 1; index < packages.length; index++) {
    const previous = packages[index - 1]!;
    const current = packages[index]!;
    const release =
      diffMode === "span" ? `${previous.version}..${current.version}` : current.version;
    const result = codeDiffFlags({ before: previous.files, after: current.files }, release);
    filesChanged += result.filesChanged;
    flags.push(...result.flags);
    if (result.filesSkipped > 0)
      notes.push(
        `${result.filesSkipped} file(s) in ${release} were too large or unparseable and were not compared`,
      );
  }
  if (diffMode === "span") {
    notes.push(
      `${range.length} releases in range: ${installed.version} and ${target} were compared once, so code signals are attributed to the span`,
    );
  }

  // 3. Registry metadata.
  flags.push(...metadataFlags(registry.versions, installed.version, target));

  // 4. Optional model, only when there is deterministic evidence to read.
  let scored = scoreFlags(flags);
  if (
    deps.model &&
    scored.confidence !== undefined &&
    flags.some((flag) => flag.category === "changelog" || flag.category === "code")
  ) {
    const request: RadarModelRequest = {
      packageName: installed.name,
      from: installed.version,
      to: target,
      changelog: flags
        .filter((flag) => flag.category === "changelog")
        .slice(0, 6)
        .map((flag) => flag.evidence),
      codeChanges: [
        ...new Set(
          flags
            .filter((flag) => flag.category === "code")
            .map((flag) => flag.location.slice(0, Math.max(0, flag.location.lastIndexOf(":")))),
        ),
      ]
        .slice(0, 3)
        .map((file) => {
          const changes = lineDiff(before.files.get(file) ?? "", after.files.get(file) ?? "");
          return { file, added: changes.added.slice(0, 12), removed: changes.removed.slice(0, 12) };
        })
        .filter((change) => change.added.length + change.removed.length > 0),
    };
    try {
      const verdict = await deps.model.classify(request);
      const flag = modelFlag(
        verdict,
        diffMode === "span" ? `${installed.version}..${target}` : target,
      );
      if (flag) flags.push(flag);
    } catch (error) {
      notes.push(
        `model classification failed (${error instanceof Error ? error.name : "error"}); deterministic signals only`,
      );
    }
    scored = scoreFlags(flags);
  }

  if (scored.confidence === undefined) return { kind: "clean" };

  // 5. Is there an advisory now? Only asked for packages that scored.
  let status: RadarEntry["status"] = "silent";
  const advisories: RadarAdvisory[] = [];
  try {
    for (const advisory of await deps.queryAdvisories(installed.name, installed.version)) {
      const inRange =
        advisory.fixedIn !== undefined &&
        semver.valid(advisory.fixedIn) !== null &&
        semver.gt(advisory.fixedIn, installed.version) &&
        semver.lte(advisory.fixedIn, target);
      if (inRange)
        advisories.push({ id: sanitizeEvidence(advisory.id, 60), fixedIn: advisory.fixedIn });
      else
        notes.push(
          `${sanitizeEvidence(advisory.id, 60)} also affects ${installed.version} but is not fixed by ${target}`,
        );
    }
    if (advisories.length > 0) status = "now-advisory";
  } catch {
    status = "unchecked";
    notes.push("OSV could not be reached, so whether an advisory exists is unknown");
  }

  const entry: RadarEntry = {
    name: installed.name,
    installed: installed.version,
    target,
    upgrade,
    direct: installed.direct,
    scope: installed.scope,
    releases: range.slice(-MAX_LISTED_RELEASES),
    diff: diffMode,
    score: scored.score,
    confidence: scored.confidence,
    breakdown: scored.breakdown,
    status,
    advisories,
    statement:
      status === "now-advisory"
        ? `An advisory now covers this range (${advisories.map((advisory) => advisory.id).join(", ")}).`
        : "Security-relevant change without a published advisory. Not a statement that a vulnerability exists.",
    flags: flags.toSorted((a, b) => b.points - a.points || a.release.localeCompare(b.release)),
    notes,
  };
  if (range.length > MAX_LISTED_RELEASES)
    entry.notes.push(
      `only the newest ${MAX_LISTED_RELEASES} of ${range.length} releases are listed`,
    );
  if (filesChanged === 0 && diffMode === "per-release")
    entry.notes.push("no source file changed between these releases");

  // 6. Upgrade impact on this project, for the few best direct dependencies.
  if (
    run.options.assess &&
    installed.direct &&
    scored.confidence !== "weak" &&
    run.assessRemaining.count > 0
  ) {
    run.assessRemaining.count--;
    try {
      const impact = await deps.assess(installed.name, installed.version, target, cwd, load);
      entry.impact = {
        rating: impact.breakability,
        summary: sanitizeEvidence(impact.summary, 200),
        findings: impact.findings.length,
      };
    } catch (error) {
      entry.notes.push(
        `upgrade impact could not be assessed (${sanitizeEvidence(errorMessage(error), 100)})`,
      );
    }
  }
  return { kind: "entry", entry };
}

/** Rank: no-advisory first, then by confidence, score, name. */
function rank(left: RadarEntry, right: RadarEntry): number {
  return (
    STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
    CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence] ||
    right.score - left.score ||
    left.name.localeCompare(right.name) ||
    semver.compare(left.installed, right.installed)
  );
}

/**
 * Look for security-relevant changes, without a published advisory, in the releases between what the
 * project has installed and a newer version. Read-only: downloads metadata and tarballs, changes
 * nothing. See `docs/guides/silent-fix-radar.md`.
 */
export async function radar(
  options: RadarOptions = {},
  overrides: Partial<RadarDeps> = {},
): Promise<RadarReport> {
  if (options.offline) {
    throw new Error(
      "radar reads the npm registry and cannot run offline. Drop --offline, or use `incident` or `remediate` with a snapshot.",
    );
  }
  const cwd = options.cwd ?? process.cwd();
  const limit = integerOption("limit", options.limit, DEFAULT_LIMIT, 1, 500);
  const maxPackages = integerOption(
    "maxPackages",
    options.maxPackages,
    DEFAULT_MAX_PACKAGES,
    1,
    2000,
  );
  const concurrency = integerOption("concurrency", options.concurrency, DEFAULT_CONCURRENCY, 1, 16);
  const timeoutMs = integerOption(
    "packageTimeoutMs",
    options.packageTimeoutMs,
    DEFAULT_PACKAGE_TIMEOUT_MS,
    1000,
    3_600_000,
  );
  const maxBytes = integerOption(
    "maxBytes",
    options.maxBytes,
    DEFAULT_MAX_BYTES,
    1024 * 1024,
    8 * 1024 * 1024 * 1024,
  );
  const target = options.target ?? "latest";
  if (!["latest", "minor", "patch"].includes(target))
    throw new Error(`target must be latest, minor or patch (got "${target as string}")`);

  const deps: RadarDeps = { ...createDefaultRadarDeps(), ...overrides };
  if (options.model && !deps.model) {
    deps.model = createLlmRadarClassifier(await resolveLanguageModel(options.model));
  }

  const installed = deps
    .listInstalled(cwd)
    .filter((entry) => options.includeTransitive === true || entry.direct)
    .toSorted(
      (a, b) =>
        Number(b.direct) - Number(a.direct) ||
        a.name.localeCompare(b.name) ||
        semver.compare(a.version, b.version),
    );
  const selected = installed.slice(0, maxPackages);

  const run: Run = {
    cwd,
    deps,
    budget: createByteBudget(maxBytes),
    options: { target, github: options.github === true, assess: options.assess !== false },
    assessRemaining: { count: MAX_ASSESSED },
    notes: new Set(),
  };

  const outcomes = await runPool(selected, concurrency, async (item): Promise<Outcome> => {
    try {
      return await withTimeout(analyse(run, item), timeoutMs, `${item.name}@${item.version}`);
    } catch (error) {
      const reason =
        error instanceof ByteBudgetExceeded
          ? "download budget spent"
          : sanitizeEvidence(errorMessage(error), 160);
      return { kind: "skipped", skipped: { name: item.name, version: item.version, reason } };
    }
  });

  const entries = outcomes
    .flatMap((outcome) => (outcome.kind === "entry" ? [outcome.entry] : []))
    .toSorted(rank);
  const skipped = outcomes.flatMap((outcome) =>
    outcome.kind === "skipped" ? [outcome.skipped] : [],
  );
  const notes = [...run.notes];
  if (installed.length > selected.length) {
    notes.push(
      `${installed.length - selected.length} package(s) beyond maxPackages (${maxPackages}) were not analysed`,
    );
  }
  if (
    options.includeTransitive &&
    installed.length > 0 &&
    !installed.some((entry) => !entry.direct)
  ) {
    notes.push(
      "No transitive packages were found: reading them needs a lockfile at the project root.",
    );
  }
  if (installed.length === 0) {
    notes.push(
      options.includeTransitive
        ? "No installed packages were found: commit a lockfile or install dependencies."
        : "No direct dependencies were found: commit a lockfile or install dependencies.",
    );
  }
  if (run.budget.used >= run.budget.limit) {
    notes.push(
      `The download budget (${maxBytes} bytes) was spent; some packages were skipped. Raise maxBytes to read them.`,
    );
  }

  return {
    schemaVersion: "1.0",
    disclaimer: RADAR_DISCLAIMER,
    target,
    includeTransitive: options.includeTransitive === true,
    analysed: outcomes.filter((outcome) => outcome.kind === "entry" || outcome.kind === "clean")
      .length,
    upToDate: outcomes.filter((outcome) => outcome.kind === "up-to-date").length,
    clean: outcomes.filter((outcome) => outcome.kind === "clean").length,
    flagged: entries.length,
    entries: entries.slice(0, limit),
    skipped,
    notes,
    bytesDownloaded: run.budget.used,
    ...(options.model || overrides.model
      ? {
          model: {
            used: deps.model !== undefined,
            ...(options.model ? { spec: options.model } : {}),
          },
        }
      : {}),
    scoring: {
      points: RADAR_POINTS,
      caps: CATEGORY_CAPS,
      thresholds: { ...CONFIDENCE_THRESHOLDS },
      rule: SCORING_RULE,
    },
  };
}
