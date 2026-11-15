import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AutoremediatorError,
  DataFormatError,
  InvalidInputError,
  NotFoundError,
  errorMessage,
} from "./errors.js";
import { asRecord, isRecord } from "./guards.js";
import { sha256 } from "./hash.js";
import { parseJson, readJsonFile, readJsonFileSync, writeJsonFileSync } from "./json.js";
import { toPosix } from "./paths.js";
import { pluralize } from "./text.js";
import { sleep } from "./time.js";

describe("errors", () => {
  it("reads the message of an Error and stringifies anything else", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });

  it("gives typed errors a stable code, a name and a cause", () => {
    const cause = new Error("root");
    const error = new NotFoundError("run r1", { cause });
    expect(error).toBeInstanceOf(AutoremediatorError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("not-found");
    expect(error.name).toBe("NotFoundError");
    expect(error.message).toBe("run r1 not found");
    expect(error.cause).toBe(cause);
    expect(new InvalidInputError("bad").code).toBe("invalid-input");
    expect(new DataFormatError("bad").code).toBe("data-format");
  });
});

describe("guards", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1])).toBeUndefined();
  });
});

describe("hash, paths, text and time", () => {
  it("hashes strings and bytes alike", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256(new TextEncoder().encode("abc"))).toBe(sha256("abc"));
  });

  it("converts backslashes to forward slashes", () => {
    expect(toPosix(String.raw`a\b\c.ts`)).toBe("a/b/c.ts");
  });

  it("pluralizes by count", () => {
    expect(pluralize(1, "file")).toBe("1 file");
    expect(pluralize(2, "file")).toBe("2 files");
    expect(pluralize(0, "entry", "entries")).toBe("0 entries");
  });

  it("resolves after the delay", async () => {
    const started = Date.now();
    await sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});

describe("json", () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "shared-json-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const schema = z.object({ name: z.string(), count: z.number() });

  it("parses text against a schema", () => {
    expect(parseJson('{"name":"a","count":2}', schema, "input")).toEqual({ name: "a", count: 2 });
  });

  it("names the source and the field when the shape is wrong", () => {
    expect(() => parseJson('{"name":"a","count":"x"}', schema, "run.json")).toThrow(
      /run\.json is not in the expected format at count/,
    );
    expect(() => parseJson("{nope", schema, "run.json")).toThrow(/run\.json is not valid JSON/);
    expect(() => parseJson("{nope", schema, "run.json")).toThrow(DataFormatError);
  });

  it("writes atomically and reads back, synchronously and asynchronously", async () => {
    const file = join(tmp(), "nested", "state.json");
    writeJsonFileSync(file, { name: "a", count: 1 });
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(readJsonFileSync(file, schema)).toEqual({ name: "a", count: 1 });
    await expect(readJsonFile(file, schema)).resolves.toEqual({ name: "a", count: 1 });
    expect(readdirSync(join(file, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
