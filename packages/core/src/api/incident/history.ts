import semver from "semver";

import { safeExeca } from "../../platform/safe-exec.js";
import {
  LOCKFILE_NAMES,
  lockFormatOf,
  parseLockGraph,
  versionsOfPackage,
} from "../../scanner/lock-graph/index.js";

export interface CommitRef {
  sha: string;
  /** Commit date, ISO 8601. */
  date: string;
}

export interface RefSet {
  branches: string[];
  tags: string[];
}

/** One version of the package in one lockfile, and when it came and went. */
export interface VersionWindow {
  version: string;
  /** The lockfile, relative to the repository root. */
  lockfile: string;
  /** Commits whose lockfile has the version where the commit before it did not. Newest first. */
  entered: CommitRef[];
  /** Commits whose lockfile lost it. Newest first. */
  left: CommitRef[];
  /** Versions of the package the lockfile had just before the version first entered, newest first. */
  previousVersions: string[];
  /** The lockfile at HEAD still has it. */
  presentAtHead: boolean;
  /** Branches and tags whose tip has it in the lockfile: a build of one of those installs it. */
  atTip: RefSet;
  /** Branches and tags whose history passes through an entering commit but whose tip no longer has it. */
  passedThrough: RefSet;
}

export interface ManifestChange {
  commit: CommitRef;
  /** What package.json declared before (absent: the package was not listed). */
  from?: string;
  /** What it declares after (absent: removed). */
  to?: string;
}

export interface PackageHistory {
  packageName: string;
  /** Every version of the package the lockfiles ever had in the scanned commits, with when. */
  versionsSeen: Array<{
    version: string;
    affected: boolean;
    firstSeen: CommitRef;
    lastSeen: CommitRef;
  }>;
  windows: VersionWindow[];
  manifestChanges: ManifestChange[];
}

export interface HistoryReport {
  /** False when there is no history to read (not a git checkout, or no commit touched a lockfile). */
  available: boolean;
  reason?: string;
  /** Lockfile commits examined. */
  scannedCommits: number;
  /** More lockfile commits exist than `maxCommits`; older ones were not examined. */
  truncated: boolean;
  shallow: boolean;
  lockfiles: string[];
  /** Lockfile versions that could not be read (corrupt, or a format that is not supported). */
  unreadable: number;
  packages: PackageHistory[];
  notes: string[];
}

export interface HistoryOptions {
  cwd: string;
  /** The packages and the version range of each that counts as affected. */
  targets: Array<{ name: string; range: string }>;
  /** Most lockfile commits to examine, newest first (default 500). */
  maxCommits?: number;
  /** Most branches and most tags to evaluate (default 200 each). */
  maxRefs?: number;
}

const ZERO = /^0+$/;
const MAX_BLOB_BYTES = 40 * 1024 * 1024;
const BATCH = 25;

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await safeExeca(
    "git",
    ["-c", "core.quotepath=off", "--no-optional-locks", ...args],
    {
      cwd,
      stdio: "pipe",
      reject: false,
      maxBuffer: 256 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
    },
  );
  if (result.exitCode !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr.split("\n")[0]}`);
  return result.stdout;
}

/** Contents of blobs by id; `undefined` for a missing or oversized one. */
async function readBlobs(cwd: string, oids: string[]): Promise<Map<string, string | undefined>> {
  const contents = new Map<string, string | undefined>();
  for (let start = 0; start < oids.length; start += BATCH) {
    const chunk = oids.slice(start, start + BATCH);
    const result = await safeExeca("git", ["--no-optional-locks", "cat-file", "--batch"], {
      cwd,
      encoding: "buffer",
      stdio: "pipe",
      reject: false,
      maxBuffer: 1024 * 1024 * 1024,
      input: `${chunk.join("\n")}\n`,
    });
    const out = Buffer.from(result.stdout);
    let at = 0;
    for (const oid of chunk) {
      const newline = out.indexOf(0x0a, at);
      if (newline === -1) break;
      const header = out.subarray(at, newline).toString("utf8").split(" ");
      at = newline + 1;
      if (header[1] !== "blob") {
        contents.set(oid, undefined);
        continue;
      }
      const size = Number(header[2]);
      contents.set(
        oid,
        size > MAX_BLOB_BYTES ? undefined : out.subarray(at, at + size).toString("utf8"),
      );
      at += size + 1;
    }
  }
  return contents;
}

interface LogEntry {
  commit: CommitRef;
  path: string;
  oldOid: string | undefined;
  newOid: string | undefined;
}

/** Commits that changed any of `pathspecs`, newest first, with the blob before and after for each path. */
async function readLog(
  cwd: string,
  pathspecs: string[],
  max: number,
): Promise<{ entries: LogEntry[]; commits: number }> {
  const out = await git(cwd, [
    "log",
    "--all",
    "--no-renames",
    "--raw",
    "--no-abbrev",
    `--max-count=${max}`,
    "--format=@@%H%x09%cI",
    "--",
    ...pathspecs,
  ]);
  const entries: LogEntry[] = [];
  let commit: CommitRef | undefined;
  let commits = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) {
      const [sha = "", date = ""] = line.slice(2).split("\t");
      // Normalised to UTC, so the same commit reads the same wherever it was made.
      commit = { sha, date: Number.isNaN(Date.parse(date)) ? date : new Date(date).toISOString() };
      commits += 1;
    } else if (line.startsWith(":") && commit) {
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const [, , oldOid = "", newOid = ""] = line.slice(1, tab).split(" ");
      const path = line.slice(tab + 1);
      // A path git had to quote (tabs, newlines, quotes) is skipped rather than guessed at.
      if (path.startsWith('"')) continue;
      entries.push({
        commit,
        path,
        oldOid: ZERO.test(oldOid) ? undefined : oldOid,
        newOid: ZERO.test(newOid) ? undefined : newOid,
      });
    }
  }
  return { entries, commits };
}

const isAffected = (version: string, range: string): boolean =>
  semver.valid(version) !== null && semver.satisfies(version, range, { includePrerelease: true });

const byVersionDesc = (a: string, b: string): number =>
  semver.valid(a) && semver.valid(b) ? semver.rcompare(a, b) : b.localeCompare(a);

const emptyRefs = (): RefSet => ({ branches: [], tags: [] });

function refSet(names: string[]): RefSet {
  const refs = emptyRefs();
  for (const name of names) {
    if (name.startsWith("refs/tags/")) refs.tags.push(name.slice("refs/tags/".length));
    else if (name.startsWith("refs/heads/")) refs.branches.push(name.slice("refs/heads/".length));
    else if (name.startsWith("refs/remotes/") && !name.endsWith("/HEAD"))
      refs.branches.push(name.slice("refs/remotes/".length));
  }
  return { branches: refs.branches.toSorted(), tags: refs.tags.toSorted() };
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];

/**
 * When did the affected versions of each package enter and leave the repository's lockfiles, and
 * which branches and tags could therefore have installed them? Reads lockfile text out of git
 * (nothing is checked out, nothing is installed) and parses it with the lockfile parsers, so it
 * works for npm, pnpm, yarn and bun lockfiles alike.
 */
export async function scanHistory(options: HistoryOptions): Promise<HistoryReport> {
  const { cwd, targets } = options;
  const max = options.maxCommits ?? 500;
  const maxRefs = options.maxRefs ?? 200;
  const base: HistoryReport = {
    available: false,
    scannedCommits: 0,
    truncated: false,
    shallow: false,
    lockfiles: [],
    unreadable: 0,
    packages: targets.map((target) => ({
      packageName: target.name,
      versionsSeen: [],
      windows: [],
      manifestChanges: [],
    })),
    notes: [],
  };

  try {
    await git(cwd, ["rev-parse", "--git-dir"]);
  } catch {
    return { ...base, reason: "not a git checkout, so there is no history to read" };
  }
  const hasCommits = await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
    () => true,
    () => false,
  );
  if (!hasCommits) return { ...base, reason: "the repository has no commits yet" };

  const shallow = (await git(cwd, ["rev-parse", "--is-shallow-repository"])).trim() === "true";
  const notes: string[] = [];
  if (shallow)
    notes.push("This is a shallow clone: history older than the clone depth is not available.");

  const lockPathspecs = [
    ...LOCKFILE_NAMES.map((name) => `:(glob)**/${name}`),
    ":(exclude,glob)**/node_modules/**",
  ];
  const { entries, commits } = await readLog(cwd, lockPathspecs, max);
  const truncated = commits >= max;
  if (truncated)
    notes.push(
      `Only the newest ${max} commits that changed a lockfile were examined; older ones were not.`,
    );
  if (entries.some((entry) => entry.path.endsWith("bun.lockb"))) {
    notes.push(
      "bun.lockb (the binary bun lockfile) cannot be read; only the text bun.lock is analysed.",
    );
  }

  const lockEntries = entries.filter((entry) => lockFormatOf(entry.path) !== undefined);
  const lockfiles = unique(lockEntries.map((entry) => entry.path)).toSorted();
  if (lockEntries.length === 0) {
    return { ...base, shallow, notes, reason: "no commit in the repository changed a lockfile" };
  }

  // Versions of each package in each distinct lockfile blob; parsed once however often it recurs.
  const needed = unique(
    lockEntries
      .flatMap((entry) => [entry.oldOid, entry.newOid])
      .filter((oid): oid is string => oid !== undefined),
  );
  const blobs = await readBlobs(cwd, needed);
  const versionCache = new Map<string, Map<string, string[]> | "unreadable">();
  const versionsIn = (
    oid: string | undefined,
    path: string,
    name: string,
  ): string[] | undefined => {
    if (oid === undefined) return [];
    let perPackage = versionCache.get(`${oid}:${path}`);
    if (perPackage === undefined) {
      const text = blobs.get(oid);
      if (text === undefined) {
        perPackage = "unreadable";
      } else {
        try {
          const graph = parseLockGraph(path, text);
          perPackage = new Map(
            targets.map((target) => [
              target.name,
              graph ? versionsOfPackage(graph, target.name) : [],
            ]),
          );
        } catch {
          perPackage = "unreadable";
        }
      }
      versionCache.set(`${oid}:${path}`, perPackage);
    }
    return perPackage === "unreadable" ? undefined : (perPackage.get(name) ?? []);
  };
  const unreadable = new Set<string>();

  const packages: PackageHistory[] = [];
  for (const target of targets) {
    interface Track {
      entered: CommitRef[];
      left: CommitRef[];
      previous: string[];
    }
    const tracks = new Map<string, Track>();
    const seen = new Map<string, { first: CommitRef; last: CommitRef }>();
    const trackOf = (path: string, version: string): Track => {
      const key = `${path}\0${version}`;
      let track = tracks.get(key);
      if (!track) {
        track = { entered: [], left: [], previous: [] };
        tracks.set(key, track);
      }
      return track;
    };

    // `lockEntries` is newest first; walking it backwards visits history oldest first.
    for (const entry of lockEntries.toReversed()) {
      const before = versionsIn(entry.oldOid, entry.path, target.name);
      const after = versionsIn(entry.newOid, entry.path, target.name);
      if (before === undefined || after === undefined) {
        unreadable.add(`${entry.commit.sha}:${entry.path}`);
        continue;
      }
      for (const version of after) {
        const range = seen.get(version);
        seen.set(version, { first: range?.first ?? entry.commit, last: entry.commit });
        if (!before.includes(version)) {
          const track = trackOf(entry.path, version);
          track.entered.unshift(entry.commit);
          // What the lockfile had right before this version first arrived.
          if (track.entered.length === 1)
            track.previous = before
              .filter((other) => !isAffected(other, target.range))
              .toSorted(byVersionDesc);
        }
      }
      for (const version of before) {
        if (!after.includes(version)) trackOf(entry.path, version).left.unshift(entry.commit);
      }
    }

    const affectedKeys = [...tracks.entries()].filter(([key]) =>
      isAffected(key.split("\0")[1]!, target.range),
    );
    packages.push({
      packageName: target.name,
      versionsSeen: [...seen.entries()]
        .map(([version, range]) => ({
          version,
          affected: isAffected(version, target.range),
          firstSeen: range.first,
          lastSeen: range.last,
        }))
        .toSorted((a, b) => byVersionDesc(a.version, b.version)),
      windows: affectedKeys.map(([key, track]) => {
        const [lockfile = "", version = ""] = key.split("\0");
        return {
          version,
          lockfile,
          entered: track.entered,
          left: track.left,
          previousVersions: track.previous,
          presentAtHead: false,
          atTip: emptyRefs(),
          passedThrough: emptyRefs(),
        };
      }),
      manifestChanges: [],
    });
  }

  // Which lockfiles, at HEAD and at the tip of each branch and tag, have an affected version.
  const refNames = (
    await git(cwd, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]).catch(() => "")
  )
    .split("\n")
    .filter((name) => name !== "" && !name.endsWith("/HEAD"));
  const branchNames = refNames.filter((name) => !name.startsWith("refs/tags/"));
  const tagNames = refNames.filter((name) => name.startsWith("refs/tags/"));
  if (branchNames.length > maxRefs || tagNames.length > maxRefs) {
    notes.push(
      `More than ${maxRefs} branches or tags exist; only the first ${maxRefs} of each were checked for what they install.`,
    );
  }
  const refs = ["HEAD", ...branchNames.slice(0, maxRefs), ...tagNames.slice(0, maxRefs)];

  const probes = refs.flatMap((ref) => lockfiles.map((path) => ({ ref, path })));
  const probeOut = await git(
    cwd,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    `${probes.map((probe) => `${probe.ref}:${probe.path}`).join("\n")}\n`,
  ).catch(() => "");
  const tipOids = probeOut.split("\n");
  const tipBlobs = unique(
    tipOids
      .map((line) => line.split(" "))
      .flatMap(([id, type]) => (type === "blob" && id ? [id] : [])),
  );
  for (const [blob, text] of await readBlobs(
    cwd,
    tipBlobs.filter((candidate) => !blobs.has(candidate)),
  ))
    blobs.set(blob, text);

  for (const history of packages) {
    const target = targets.find((candidate) => candidate.name === history.packageName)!;
    for (const window of history.windows) {
      const atTip: string[] = [];
      for (const [index, probe] of probes.entries()) {
        if (probe.path !== window.lockfile) continue;
        const [oid, type] = (tipOids[index] ?? "").split(" ");
        if (type !== "blob" || !oid) continue;
        if (!versionsIn(oid, probe.path, target.name)?.includes(window.version)) continue;
        if (probe.ref === "HEAD") window.presentAtHead = true;
        else atTip.push(probe.ref);
      }
      window.atTip = refSet(atTip);

      const entering = window.entered.slice(0, 20);
      const through = (
        await Promise.all(
          entering.map((commit) =>
            git(cwd, [
              "for-each-ref",
              "--format=%(refname)",
              `--contains=${commit.sha}`,
              "refs/heads",
              "refs/remotes",
              "refs/tags",
            ]).catch(() => ""),
          ),
        )
      )
        .flatMap((text) => text.split("\n"))
        .filter((name) => name !== "");
      const tipSet = new Set(atTip);
      window.passedThrough = refSet(unique(through).filter((name) => !tipSet.has(name)));
    }
    history.windows.sort(
      (a, b) => byVersionDesc(a.version, b.version) || a.lockfile.localeCompare(b.lockfile),
    );
  }

  // package.json: when the declared range of each package changed.
  const manifest = await readLog(cwd, ["package.json"], max).catch(() => ({
    entries: [] as LogEntry[],
    commits: 0,
  }));
  const manifestBlobs = await readBlobs(
    cwd,
    unique(
      manifest.entries
        .flatMap((entry) => [entry.oldOid, entry.newOid])
        .filter((oid): oid is string => oid !== undefined),
    ),
  );
  const declared = (oid: string | undefined, name: string): string | undefined => {
    const text = oid === undefined ? undefined : manifestBlobs.get(oid);
    if (text === undefined) return undefined;
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        const table = json[field];
        const value =
          typeof table === "object" && table !== null
            ? (table as Record<string, unknown>)[name]
            : undefined;
        if (typeof value === "string") return value;
      }
    } catch {
      // A package.json that does not parse says nothing about the package.
    }
    return undefined;
  };
  for (const history of packages) {
    const changes: ManifestChange[] = [];
    for (const entry of manifest.entries) {
      const from = declared(entry.oldOid, history.packageName);
      const to = declared(entry.newOid, history.packageName);
      if (from === to) continue;
      const change: ManifestChange = { commit: entry.commit };
      if (from !== undefined) change.from = from;
      if (to !== undefined) change.to = to;
      changes.push(change);
    }
    history.manifestChanges = changes.slice(0, 50);
  }

  return {
    available: true,
    scannedCommits: commits,
    truncated,
    shallow,
    lockfiles,
    unreadable: unreadable.size,
    packages,
    notes,
  };
}
