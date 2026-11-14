import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isEntrypoint } from "./entrypoint.js";

describe("isEntrypoint", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "entrypoint-"));
    dirs.push(dir);
    const real = join(dir, "real.js");
    writeFileSync(real, "");
    return { dir, real, url: pathToFileURL(real).href };
  }

  it("matches the real path", () => {
    const { real, url } = fixture();
    expect(isEntrypoint(url, real)).toBe(true);
  });

  it("matches when launched through a symlink (npm bin)", () => {
    const { dir, real, url } = fixture();
    const link = join(dir, "bin-link");
    symlinkSync(real, link);
    expect(isEntrypoint(url, link)).toBe(true);
  });

  it("rejects a different script, a missing argv and a missing path", () => {
    const { dir, url } = fixture();
    const other = join(dir, "other.js");
    writeFileSync(other, "");
    expect(isEntrypoint(url, other)).toBe(false);
    expect(isEntrypoint(url, undefined)).toBe(false);
    expect(isEntrypoint(url, join(dir, "missing.js"))).toBe(false);
  });
});
