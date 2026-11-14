import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ProjectSnapshot } from "../platform/rollback.js";
import { sha256 } from "./hash.js";

interface SnapshotManifest {
  version: 1;
  cwd: string;
  isGit: boolean;
  gitRoot?: string;
  gitStatusBefore?: string[];
  /** Relative path -> blob hash, or null when the file did not exist. */
  files: Record<string, string | null>;
}

/** Content is kept as latin1 in memory (byte-exact for any file); store the bytes themselves. */
const toBytes = (content: string) => Buffer.from(content, "latin1");

/**
 * Persist a rollback snapshot under `dir` (`snapshot.json` plus content-addressed `blobs/`), so a
 * run can be undone after the process that made it has exited.
 */
export function saveSnapshot(dir: string, snapshot: ProjectSnapshot): void {
  const blobs = join(dir, "blobs");
  mkdirSync(blobs, { recursive: true });

  const files: Record<string, string | null> = {};
  for (const [path, content] of snapshot.fileSnapshots) {
    if (content === null) {
      files[path] = null;
      continue;
    }
    const bytes = toBytes(content);
    const hash = sha256(bytes);
    writeFileSync(join(blobs, hash), bytes);
    files[path] = hash;
  }

  const manifest: SnapshotManifest = {
    version: 1,
    cwd: snapshot.cwd,
    isGit: snapshot.isGit,
    ...(snapshot.gitRoot ? { gitRoot: snapshot.gitRoot } : {}),
    ...(snapshot.gitStatusBefore ? { gitStatusBefore: snapshot.gitStatusBefore } : {}),
    files,
  };
  writeFileSync(join(dir, "snapshot.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function loadSnapshot(dir: string): ProjectSnapshot {
  const manifest = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8")) as SnapshotManifest;
  const fileSnapshots = new Map<string, string | null>();
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (hash === null) {
      fileSnapshots.set(path, null);
      continue;
    }
    const bytes = readFileSync(join(dir, "blobs", hash));
    if (sha256(bytes) !== hash) throw new Error(`Snapshot blob for "${path}" is corrupt.`);
    fileSnapshots.set(path, bytes.toString("latin1"));
  }
  return {
    cwd: manifest.cwd,
    isGit: manifest.isGit,
    ...(manifest.gitRoot ? { gitRoot: manifest.gitRoot } : {}),
    ...(manifest.gitStatusBefore ? { gitStatusBefore: manifest.gitStatusBefore } : {}),
    fileSnapshots,
  };
}
