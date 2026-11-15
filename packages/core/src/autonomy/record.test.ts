/** The track record on a real file system: format, validation, and concurrent appends. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendTrackEvents,
  readTrackRecord,
  recordPathOf,
  serializeRecord,
  TrackRecordError,
} from "./record.js";
import type { NewTrackEvent } from "./types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "track-record-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const runId = (n: number) => `run_${String(n).padStart(20, "0")}`;
const event = (n: number, overrides: Partial<NewTrackEvent> = {}): NewTrackEvent => ({
  type: "applied-verified",
  runId: runId(n),
  cveIds: ["CVE-2021-23337"],
  packages: ["lodash"],
  coverage: { tests: true, typecheck: false },
  detail: `lodash 4.17.20 -> 4.17.21 (version-bump): applied`,
  ...overrides,
});
const write = (text: string) => {
  mkdirSync(join(dir, ".autoremediator"), { recursive: true });
  writeFileSync(recordPathOf(dir), text, "utf8");
};

describe("reading", () => {
  it("is empty when there is no file", () => {
    expect(readTrackRecord(dir)).toEqual({ schemaVersion: 1, events: [] });
  });

  it("round-trips what was appended, in order, with sequence numbers and a timestamp", async () => {
    const fixed = () => new Date("2026-03-04T05:06:07.000Z");
    await appendTrackEvents(dir, [event(1), event(2, { type: "rollback" })], { now: fixed });
    await appendTrackEvents(dir, [event(3)], { now: fixed });

    const record = readTrackRecord(dir);
    expect(record.schemaVersion).toBe(1);
    expect(record.events.map((e) => [e.seq, e.type, e.runId])).toEqual([
      [1, "applied-verified", runId(1)],
      [2, "rollback", runId(2)],
      [3, "applied-verified", runId(3)],
    ]);
    expect(record.events[0]?.at).toBe("2026-03-04T05:06:07.000Z");
  });

  it("is human-reviewable: valid JSON with one event per line", async () => {
    await appendTrackEvents(dir, [event(1), event(2)]);
    const text = readFileSync(recordPathOf(dir), "utf8");
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1 });
    expect(text.split("\n").filter((line) => line.includes('"seq"'))).toHaveLength(2);
    expect(text.startsWith('{\n  "schemaVersion": 1,\n  "events": [\n')).toBe(true);
    expect(serializeRecord({ schemaVersion: 1, events: [] })).toBe(
      '{\n  "schemaVersion": 1,\n  "events": []\n}\n',
    );
  });

  it("appending adds one line and leaves the earlier ones byte for byte", async () => {
    await appendTrackEvents(dir, [event(1)]);
    const before = readFileSync(recordPathOf(dir), "utf8").split("\n");
    await appendTrackEvents(dir, [event(2)]);
    const after = readFileSync(recordPathOf(dir), "utf8").split("\n");
    const firstEvent = before.findIndex((line) => line.includes('"seq":1'));
    expect(after[firstEvent]).toBe(`${before[firstEvent]},`); // gains only the separating comma
    expect(after).toHaveLength(before.length + 1);
  });

  it("keeps detail to one short line", async () => {
    await appendTrackEvents(dir, [event(1, { detail: `first line\n${"x".repeat(500)}` })]);
    expect(readTrackRecord(dir).events[0]?.detail).toBe("first line");
    await appendTrackEvents(dir, [event(2, { detail: "y".repeat(500) })]);
    const long = readTrackRecord(dir).events[1]!.detail;
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("damaged records are refused, never replaced", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["not JSON", "{nope", /not valid JSON/],
    ["an unknown schemaVersion", '{"schemaVersion":2,"events":[]}', /invalid/],
    ["an unknown key", '{"schemaVersion":1,"events":[],"extra":1}', /invalid/],
    [
      "an unknown event type",
      `{"schemaVersion":1,"events":[{"seq":1,"at":"2026-01-01T00:00:00.000Z","type":"promoted","runId":"${runId(1)}","cveIds":[],"packages":[],"coverage":{"tests":false,"typecheck":false},"detail":""}]}`,
      /invalid/,
    ],
    [
      "a gap in the sequence (an event was removed)",
      `{"schemaVersion":1,"events":[{"seq":2,"at":"2026-01-01T00:00:00.000Z","type":"rollback","runId":"${runId(1)}","cveIds":[],"packages":[],"coverage":{"tests":false,"typecheck":false},"detail":""}]}`,
      /expected event 1 but found 2/,
    ],
  ];
  for (const [name, text, message] of cases) {
    it(`refuses ${name}`, async () => {
      write(text);
      expect(() => readTrackRecord(dir)).toThrow(TrackRecordError);
      expect(() => readTrackRecord(dir)).toThrow(message);
      await expect(appendTrackEvents(dir, [event(1)])).rejects.toThrow(message);
      expect(readFileSync(recordPathOf(dir), "utf8")).toBe(text);
    });
  }

  it("reports a record that cannot be read as damaged", () => {
    mkdirSync(recordPathOf(dir), { recursive: true }); // a directory where the file should be
    expect(() => readTrackRecord(dir)).toThrow(TrackRecordError);
  });

  it("refuses an event that would not validate, leaving the file alone", async () => {
    await appendTrackEvents(dir, [event(1)]);
    const before = readFileSync(recordPathOf(dir), "utf8");
    await expect(appendTrackEvents(dir, [event(2, { runId: "not-a-run" })])).rejects.toThrow(
      TrackRecordError,
    );
    expect(readFileSync(recordPathOf(dir), "utf8")).toBe(before);
  });
});

describe("the hash chain", () => {
  const readJson = (): { schemaVersion: number; head?: string; events: Array<Record<string, unknown>> } =>
    JSON.parse(readFileSync(recordPathOf(dir), "utf8")) as ReturnType<typeof readJson>;
  const writeJson = (value: unknown) => write(JSON.stringify(value));
  const fixed = () => new Date("2026-03-04T05:06:07.000Z");
  const chain = /hash chain is broken/;

  it("links every event to the one before it and records the head", async () => {
    await appendTrackEvents(dir, [event(1), event(2, { type: "rollback" })], { now: fixed });
    await appendTrackEvents(dir, [event(3)], { now: fixed });
    const json = readJson();
    expect(json.events[0]!["prev"]).toMatch(/^0{64}$/);
    expect(new Set(json.events.map((e) => e["prev"])).size).toBe(3);
    expect(json.head).toMatch(/^[0-9a-f]{64}$/);
    expect(readTrackRecord(dir).events).toHaveLength(3);
  });

  it("refuses an incident whose date was moved into the past (the cooldown cannot be dodged)", async () => {
    await appendTrackEvents(dir, [event(1), event(2, { type: "rollback" })], { now: fixed });
    await appendTrackEvents(dir, [event(3)], { now: fixed });
    const json = readJson();
    json.events[1]!["at"] = "2020-01-01T00:00:00.000Z";
    writeJson(json);
    expect(() => readTrackRecord(dir)).toThrow(TrackRecordError);
    expect(() => readTrackRecord(dir)).toThrow(chain);
  });

  it("refuses an edit to the latest event, which no later event vouches for", async () => {
    await appendTrackEvents(dir, [event(1), event(2, { type: "rollback" })], { now: fixed });
    const json = readJson();
    json.events[1]!["at"] = "2020-01-01T00:00:00.000Z";
    writeJson(json);
    expect(() => readTrackRecord(dir)).toThrow(chain);
  });

  it("refuses events reordered, even when the sequence numbers are renumbered", async () => {
    await appendTrackEvents(dir, [event(1), event(2, { type: "rollback" }), event(3)], { now: fixed });
    const json = readJson();
    json.events = [json.events[1]!, json.events[0]!, json.events[2]!].map((e, index) => Object.assign(e, { seq: index + 1 }));
    writeJson(json);
    expect(() => readTrackRecord(dir)).toThrow(chain);
  });

  it("refuses fabricated events that carry no hash, or a made-up one, and leaves the file alone", async () => {
    await appendTrackEvents(dir, [event(1)], { now: fixed });
    const fake = {
      seq: 2,
      at: "2026-03-04T05:06:07.000Z",
      type: "applied-verified",
      runId: runId(99),
      cveIds: [],
      packages: [],
      coverage: { tests: true, typecheck: true },
      detail: "fabricated",
    };
    const json = readJson();
    writeJson({ ...json, events: [...json.events, fake] });
    expect(() => readTrackRecord(dir)).toThrow(/some events carry a hash and some do not/);

    writeJson({ ...json, events: [...json.events, { ...fake, prev: "a".repeat(64) }] });
    expect(() => readTrackRecord(dir)).toThrow(chain);
    const text = readFileSync(recordPathOf(dir), "utf8");
    await expect(appendTrackEvents(dir, [event(3)])).rejects.toThrow(chain);
    expect(readFileSync(recordPathOf(dir), "utf8")).toBe(text);
  });

  it("explains how to recover in the message", async () => {
    await appendTrackEvents(dir, [event(1), event(2)], { now: fixed });
    const json = readJson();
    json.events[0]!["detail"] = "edited";
    writeJson(json);
    expect(() => readTrackRecord(dir)).toThrow(/broken at event 2.*version control/s);
  });

  describe("a record written before hashes existed", () => {
    const legacy = (count: number) => ({
      schemaVersion: 1,
      events: Array.from({ length: count }, (_, index) => ({
        seq: index + 1,
        at: "2026-01-01T00:00:00.000Z",
        type: "applied-verified",
        runId: runId(index + 1),
        cveIds: ["CVE-2021-23337"],
        packages: ["lodash"],
        coverage: { tests: true, typecheck: false },
        detail: "lodash: applied",
      })),
    });

    it("is accepted as it is", () => {
      writeJson(legacy(3));
      expect(readTrackRecord(dir).events.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it("is upgraded on the next append: every event is chained and nothing else changes", async () => {
      writeJson(legacy(3));
      await appendTrackEvents(dir, [event(4)], { now: fixed });

      const record = readTrackRecord(dir);
      expect(record.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      expect(record.events.every((e) => typeof e.prev === "string")).toBe(true);
      // The old events keep their content.
      const upgraded = readJson().events.slice(0, 3).map(({ prev: _prev, ...rest }) => rest);
      expect(upgraded).toEqual(legacy(3).events);
      // And from then on the chain is enforced: stripping a hash is refused.
      const json = readJson();
      delete json.events[1]!["prev"];
      writeJson(json);
      expect(() => readTrackRecord(dir)).toThrow(/some events carry a hash and some do not/);
    });
  });
});

describe("concurrent appends", () => {
  it("loses no event and numbers none twice when many writers race", async () => {
    const writers = 40;
    await Promise.all(
      Array.from({ length: writers }, (_, n) =>
        appendTrackEvents(dir, [event(n + 1), event(n + 1, { type: "verify-passed" })]),
      ),
    );

    const record = readTrackRecord(dir);
    expect(record.events).toHaveLength(writers * 2);
    expect(record.events.map((e) => e.seq)).toEqual(
      Array.from({ length: writers * 2 }, (_, i) => i + 1),
    );
    // Each writer's pair stays together and in order.
    const runs = new Set(record.events.map((e) => e.runId));
    expect(runs.size).toBe(writers);
    for (let i = 0; i < record.events.length; i += 2) {
      expect(record.events[i]?.runId).toBe(record.events[i + 1]?.runId);
      expect(record.events[i]?.type).toBe("applied-verified");
    }
    // No lock or temp file is left behind.
    expect(existsSync(join(dir, ".autoremediator", "locks", "track-record.lock"))).toBe(false);
    expect(existsSync(`${recordPathOf(dir)}.tmp-${process.pid}`)).toBe(false);
  });

  it("takes over a lock left by a process that died", async () => {
    const lock = join(dir, ".autoremediator", "locks", "track-record.lock");
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);

    await appendTrackEvents(dir, [event(1)], { timeoutMs: 2000 });
    expect(readTrackRecord(dir).events).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("gives up with a clear error when a live lock is never released", async () => {
    mkdirSync(join(dir, ".autoremediator", "locks", "track-record.lock"), { recursive: true });
    await expect(appendTrackEvents(dir, [event(1)], { timeoutMs: 150 })).rejects.toThrow(
      /Timed out waiting for the track record lock/,
    );
  });
});
