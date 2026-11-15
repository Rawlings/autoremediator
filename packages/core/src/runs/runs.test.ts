import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fingerprintRepo, sameInputs } from "./fingerprint.js";
import { canonicalJson, sha256 } from "./hash.js";
import { isPlanId, isRunId, newRunId } from "./ids.js";
import { Ledger } from "./ledger.js";
import { RunStore } from "./run-store.js";
import { loadSnapshot, saveSnapshot } from "./snapshot-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("canonicalJson / ids", () => {
  it("serialises equal values identically regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }] })).toBe(
      canonicalJson({ a: [{ c: undefined, d: 2 }], b: 1 }),
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(sha256("x")).toHaveLength(64);
  });

  it("generates run ids that pass validation, and rejects anything path-like", () => {
    expect(isRunId(newRunId())).toBe(true);
    expect(newRunId()).not.toBe(newRunId());
    for (const bad of [
      "../etc",
      "run_short",
      "run_" + "A".repeat(20),
      "run_/../../x" + "a".repeat(8),
      5,
    ]) {
      expect(isRunId(bad)).toBe(false);
    }
    expect(isPlanId("plan_0123456789abcdef")).toBe(true);
    expect(isPlanId("plan_xyz")).toBe(false);
  });
});

describe("Ledger", () => {
  it("chains events and verifies", () => {
    const ledger = new Ledger(join(dir, "steps.jsonl"));
    ledger.append("a", { n: 1 });
    ledger.append("b");
    const events = ledger.read();
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[1]?.prevHash).toBe(events[0]?.hash);
    expect(ledger.verify()).toEqual({ ok: true });
  });

  it("continues the chain from an existing file", () => {
    new Ledger(join(dir, "steps.jsonl")).append("a");
    const again = new Ledger(join(dir, "steps.jsonl"));
    again.append("b");
    expect(again.verify()).toEqual({ ok: true });
    expect(again.read().map((event) => event.seq)).toEqual([1, 2]);
  });

  it("stays one chain when several holders of the same file append in turn", () => {
    const file = join(dir, "steps.jsonl");
    const one = new Ledger(file);
    const two = new Ledger(file);
    one.append("a");
    two.append("b");
    one.append("c");
    expect(one.read().map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(two.verify()).toEqual({ ok: true });
  });

  it("detects edited, removed and reordered events", () => {
    const file = join(dir, "steps.jsonl");
    const ledger = new Ledger(file);
    ledger.append("a", { n: 1 });
    ledger.append("b", { n: 2 });
    ledger.append("c", { n: 3 });
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");

    writeFileSync(
      file,
      [lines[0]!.replace('"n":1', '"n":9'), lines[1], lines[2]].join("\n") + "\n",
    );
    expect(ledger.verify()).toMatchObject({ ok: false, seq: 1 });

    writeFileSync(file, [lines[0], lines[2]].join("\n") + "\n");
    expect(ledger.verify()).toMatchObject({ ok: false });

    writeFileSync(file, [lines[1], lines[0], lines[2]].join("\n") + "\n");
    expect(ledger.verify()).toMatchObject({ ok: false });
  });

  it("reports an unreadable line instead of throwing", () => {
    const file = join(dir, "steps.jsonl");
    writeFileSync(file, "not json\n");
    expect(new Ledger(file).verify()).toMatchObject({ ok: false });
  });
});

describe("fingerprintRepo", () => {
  it("changes when a manifest changes and ignores unrelated files", async () => {
    writeFileSync(join(dir, "package.json"), '{"name":"a"}');
    writeFileSync(join(dir, "package-lock.json"), "{}");
    const before = await fingerprintRepo(dir);
    writeFileSync(join(dir, "README.md"), "hi");
    expect(sameInputs(await fingerprintRepo(dir), before)).toBe(true);

    writeFileSync(join(dir, "package.json"), '{"name":"b"}');
    expect(sameInputs(await fingerprintRepo(dir), before)).toBe(false);
  });

  it("covers the policy in force", async () => {
    writeFileSync(join(dir, "package.json"), "{}");
    const none = await fingerprintRepo(dir);
    expect(none.policySha256).toBeUndefined();

    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github", "autoremediator.yml"), "allowMajorBumps: true\n");
    const withPolicy = await fingerprintRepo(dir);
    expect(withPolicy.policySha256).toBeDefined();
    expect(sameInputs(withPolicy, none)).toBe(false);

    writeFileSync(join(dir, ".github", "autoremediator.yml"), "allowMajorBumps: false\n");
    expect(sameInputs(await fingerprintRepo(dir), withPolicy)).toBe(false);
  });
});

describe("snapshot store", () => {
  it("round-trips text, binary-like bytes and missing files", () => {
    const fileSnapshots = new Map<string, string | null>([
      ["package.json", '{"name":"é"}'],
      ["bun.lockb", Buffer.from([0, 255, 128, 10, 13]).toString("latin1")],
      ["new-file.json", null],
    ]);
    saveSnapshot(join(dir, "snap"), {
      cwd: "/p",
      isGit: true,
      gitRoot: "/p",
      gitStatusBefore: [" M a"],
      fileSnapshots,
    });

    const loaded = loadSnapshot(join(dir, "snap"));
    expect(loaded.cwd).toBe("/p");
    expect(loaded.gitStatusBefore).toEqual([" M a"]);
    expect([...loaded.fileSnapshots.entries()]).toEqual([...fileSnapshots.entries()]);
  });

  it("refuses a blob that no longer matches its hash", () => {
    saveSnapshot(join(dir, "snap"), {
      cwd: "/p",
      isGit: false,
      fileSnapshots: new Map([["package.json", "{}"]]),
    });
    const blob = sha256(Buffer.from("{}", "latin1"));
    writeFileSync(join(dir, "snap", "blobs", blob), "tampered");
    expect(() => loadSnapshot(join(dir, "snap"))).toThrow(/corrupt/);
  });
});

describe("RunStore", () => {
  const base = { dirty: false, filesSha256: "f" };

  it("creates, updates, lists newest first and rejects bad ids", async () => {
    const store = new RunStore(dir);
    const first = store.create({ cwd: dir, cveIds: ["CVE-1"], base });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    const second = store.create({ cwd: dir, cveIds: ["CVE-2"], base });

    store.update(first.runId, { status: "applied" });
    expect(store.load(first.runId).status).toBe("applied");
    expect(store.list().map((run) => run.runId)).toEqual([second.runId, first.runId]);
    expect(() => store.load(newRunId())).toThrow(/not found/);
    expect(() => store.runDir("../../etc")).toThrow(/Invalid run id/);
  });

  it("skips damaged runs when listing", () => {
    const store = new RunStore(dir);
    const ok = store.create({ cwd: dir, cveIds: [], base });
    const broken = store.create({ cwd: dir, cveIds: [], base });
    writeFileSync(join(store.runDir(broken.runId), "run.json"), "{nope");
    expect(store.list().map((run) => run.runId)).toEqual([ok.runId]);
  });

  it("serialises appliers with a lock that a dead owner cannot hold", () => {
    const store = new RunStore(dir);
    const run = store.create({ cwd: dir, cveIds: [], base });
    const release = store.acquireApplyLock(run.runId);
    expect(() => store.acquireApplyLock(run.runId)).toThrow(/already being applied/);
    release();
    store.acquireApplyLock(run.runId)();

    // Left behind by a process that no longer exists.
    writeFileSync(join(store.runDir(run.runId), "apply.lock"), "2147483646");
    expect(() => store.acquireApplyLock(run.runId)()).not.toThrow();
  });
});
