import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  COPILOT_HOOKS_PATH,
  copilotGuardHookEntry,
  CURSOR_HOOKS_PATH,
  cursorGuardHookEntry,
  PNPMFILE_PATH,
  pnpmfileGuardContent,
} from "./guard-assets.js";
import { init } from "./index.js";
import { mergeHooksFile } from "./merge.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "guard-assets-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const put = (path: string, content: string): void => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const read = (path: string): string => readFileSync(join(dir, path), "utf8");

describe("hook entries", () => {
  it("builds the Cursor entry from documented fields only", () => {
    const entry = cursorGuardHookEntry("^1.2.3");
    expect(Object.keys(entry).toSorted()).toEqual(["command", "matcher", "timeout"]);
    expect(entry.command).toBe(
      `npx -y -p autoremediator@^1.2.3 autoremediator guard-hook --host cursor || echo '{"permission":"allow"}'`,
    );
  });

  it("lets the command through, with JSON, when the guard cannot run (no npx, no network)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "no-npx-"));
    try {
      const result = await execa("/bin/sh", ["-c", String(cursorGuardHookEntry().command)], {
        env: { PATH: empty },
        extendEnv: false,
        reject: false,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ permission: "allow" });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("builds the Copilot entry so that a failing guard cannot deny every command", () => {
    const entry = copilotGuardHookEntry("^1.2.3");
    expect(Object.keys(entry).toSorted()).toEqual([
      "bash",
      "matcher",
      "powershell",
      "timeoutSec",
      "type",
    ]);
    expect(entry.bash).toContain("guard-hook --host copilot || true");
    expect(entry.bash).toContain("*npm*|*pnpm*|*yarn*|*bun*");
    expect(entry.powershell).toMatch(/exit 0$/);
    expect(entry.matcher).toBe("bash|powershell");
  });
});

describe("mergeHooksFile", () => {
  const entry = { command: "x guard-hook", matcher: "npm" };

  it("creates a versioned hooks file", () => {
    const merged = mergeHooksFile(undefined, "beforeShellExecution", entry) as { content: string };
    expect(JSON.parse(merged.content)).toEqual({
      version: 1,
      hooks: { beforeShellExecution: [entry] },
    });
  });

  it("keeps the user's other hooks, events and keys, and the file's indentation", () => {
    const existing = JSON.stringify(
      {
        version: 1,
        extra: true,
        hooks: { beforeShellExecution: [{ command: "mine" }], afterFileEdit: [{ command: "fmt" }] },
      },
      null,
      4,
    );
    const merged = mergeHooksFile(existing, "beforeShellExecution", entry) as { content: string };
    const parsed = JSON.parse(merged.content);
    expect(parsed.extra).toBe(true);
    expect(parsed.hooks.afterFileEdit).toEqual([{ command: "fmt" }]);
    expect(parsed.hooks.beforeShellExecution).toEqual([{ command: "mine" }, entry]);
    expect(merged.content).toContain('\n    "extra"');
  });

  it("leaves a file that already runs the guard unchanged, in any field", () => {
    const existing = JSON.stringify({
      version: 1,
      hooks: {
        preToolUse: [{ type: "command", bash: "a | autoremediator guard-hook --host copilot" }],
      },
    });
    const merged = mergeHooksFile(existing, "preToolUse", { type: "command", bash: "other" }) as {
      content: string;
    };
    expect(JSON.parse(merged.content).hooks.preToolUse).toHaveLength(1);
  });

  it("does not touch a file it cannot read safely", () => {
    expect(mergeHooksFile("{ nope", "preToolUse", entry)).toHaveProperty("conflict");
    expect(mergeHooksFile("[]", "preToolUse", entry)).toHaveProperty("conflict");
    expect(mergeHooksFile('{"hooks": []}', "preToolUse", entry)).toHaveProperty("conflict");
    expect(mergeHooksFile('{"hooks": {"preToolUse": {}}}', "preToolUse", entry)).toHaveProperty(
      "conflict",
    );
  });
});

describe("init --guard for each host", () => {
  it("writes the Cursor hook next to the user's own, only when asked", async () => {
    put(
      CURSOR_HOOKS_PATH,
      JSON.stringify({
        version: 1,
        hooks: { beforeShellExecution: [{ command: ".cursor/hooks/mine.sh" }] },
      }),
    );
    await init({ cwd: dir, hosts: ["cursor"], yes: true });
    expect(JSON.parse(read(CURSOR_HOOKS_PATH)).hooks.beforeShellExecution).toHaveLength(1);

    await init({ cwd: dir, hosts: ["cursor"], guard: true, yes: true });
    const hooks = JSON.parse(read(CURSOR_HOOKS_PATH)).hooks.beforeShellExecution as Array<{
      command: string;
    }>;
    expect(hooks).toHaveLength(2);
    expect(hooks[0]?.command).toBe(".cursor/hooks/mine.sh");
    expect(hooks[1]?.command).toContain("guard-hook --host cursor");
    expect((await init({ cwd: dir, hosts: ["cursor"], guard: true, yes: true })).drift).toBe(false);
  });

  it("writes one Copilot hook file for Copilot and for VS Code, and not for other hosts", async () => {
    await init({ cwd: dir, hosts: ["copilot", "vscode"], guard: true, yes: true });
    const file = JSON.parse(read(COPILOT_HOOKS_PATH)) as {
      version: number;
      hooks: { preToolUse: unknown[] };
    };
    expect(file.version).toBe(1);
    expect(file.hooks.preToolUse).toHaveLength(1);

    rmSync(join(dir, COPILOT_HOOKS_PATH));
    await init({ cwd: dir, hosts: ["vscode"], guard: true, yes: true });
    expect(existsSync(join(dir, COPILOT_HOOKS_PATH))).toBe(true);

    rmSync(join(dir, COPILOT_HOOKS_PATH));
    await init({ cwd: dir, hosts: ["gemini", "codex"], guard: true, yes: true });
    expect(existsSync(join(dir, COPILOT_HOOKS_PATH))).toBe(false);
  });

  it("reports a hook file it cannot parse instead of overwriting it", async () => {
    put(CURSOR_HOOKS_PATH, "{ not json");
    const result = await init({ cwd: dir, hosts: ["cursor"], guard: true, yes: true });
    expect(result.conflicts.join("\n")).toContain(CURSOR_HOOKS_PATH);
    expect(read(CURSOR_HOOKS_PATH)).toBe("{ not json");
  });
});

describe("init --guard pnpmfile", () => {
  const pnpmProject = () => put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");

  it("writes the pnpmfile for pnpm projects only", async () => {
    await init({ cwd: dir, hosts: [], guard: true, yes: true });
    expect(existsSync(join(dir, PNPMFILE_PATH))).toBe(false);

    pnpmProject();
    await init({ cwd: dir, hosts: [], guard: true, yes: true });
    expect(read(PNPMFILE_PATH)).toBe(pnpmfileGuardContent());
    expect((await init({ cwd: dir, hosts: [], guard: true, yes: true })).drift).toBe(false);
  });

  it("never overwrites a pnpmfile of the user's, and says why", async () => {
    pnpmProject();
    put(PNPMFILE_PATH, "module.exports = { hooks: {} };\n");
    const result = await init({ cwd: dir, hosts: [], guard: true, yes: true });
    expect(read(PNPMFILE_PATH)).toBe("module.exports = { hooks: {} };\n");
    expect(result.conflicts.join("\n")).toContain(PNPMFILE_PATH);

    rmSync(join(dir, PNPMFILE_PATH));
    put(".pnpmfile.mjs", "export const hooks = {};\n");
    const mjs = await init({ cwd: dir, hosts: [], guard: true, yes: true });
    expect(existsSync(join(dir, PNPMFILE_PATH))).toBe(false);
    expect(mjs.conflicts).toContain(PNPMFILE_PATH);
    expect(mjs.changes.find((change) => change.path === PNPMFILE_PATH)?.reason).toContain(
      ".pnpmfile.mjs",
    );
  });
});

describe.skipIf(process.platform === "win32")("the generated pnpmfile", () => {
  const LOCKFILE = [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    "      is-number:",
    "        specifier: ^7.0.0",
    "        version: 7.0.0",
    "      '@scope/pkg':",
    "        specifier: 1.2.3",
    "        version: 1.2.3",
    "",
  ].join("\n");

  /** Load the pnpmfile and a fake `autoremediator` that records what it was asked and answers `reply`. */
  function load(reply: { status: number; body: unknown }, files: { lock?: string | null } = {}) {
    put("package.json", JSON.stringify({ name: "app", version: "1.0.0" }));
    if (files.lock !== null) put("pnpm-lock.yaml", files.lock ?? LOCKFILE);
    put(PNPMFILE_PATH, pnpmfileGuardContent("^9.9.9"));
    const bin = join(dir, "fake-autoremediator.sh");
    writeFileSync(
      bin,
      `#!/bin/sh\necho "$@" > "${join(dir, "asked.txt")}"\ncat <<'JSON'\n${JSON.stringify(reply.body)}\nJSON\nexit ${reply.status}\n`,
    );
    chmodSync(bin, 0o755);
    process.env.AUTOREMEDIATOR_BIN = bin;
    // A fresh module each time: the file keeps per-process state.
    const require = createRequire(join(dir, "loader.cjs"));
    delete require.cache[require.resolve(join(dir, PNPMFILE_PATH))];
    const logged: string[] = [];
    const hooks = require(join(dir, PNPMFILE_PATH)).hooks as {
      readPackage: (
        pkg: Record<string, unknown>,
        context: { log: (message: string) => void },
      ) => Record<string, unknown>;
    };
    const readPackage = (pkg: Record<string, unknown>) =>
      hooks.readPackage(pkg, { log: (message) => logged.push(message) });
    return {
      readPackage,
      logged,
      asked: () => (existsSync(join(dir, "asked.txt")) ? read("asked.txt").trim() : undefined),
    };
  }
  afterEach(() => {
    delete process.env.AUTOREMEDIATOR_BIN;
    delete process.env.AUTOREMEDIATOR_GUARD;
  });
  const project = (dependencies: Record<string, string>) => ({
    name: "app",
    version: "1.0.0",
    dependencies,
  });
  const blockedReport = {
    spec: "lodahs@^1.0.0",
    verdict: "block",
    findings: [{ severity: "block", message: "does not exist" }],
  };

  it("checks only dependencies the lockfile does not already list, and stops the install on a block", () => {
    const { readPackage, asked } = load({ status: 4, body: blockedReport });
    expect(() =>
      readPackage(project({ "is-number": "^7.0.0", "@scope/pkg": "1.2.3", lodahs: "^1.0.0" })),
    ).toThrow(/blocked this install[\s\S]*does not exist/);
    expect(asked()).toBe("guard lodahs@^1.0.0 --output-format json");
  });

  it("treats a changed specifier as new, and ignores local protocols", () => {
    const { readPackage, asked } = load({
      status: 0,
      body: { spec: "x", verdict: "allow", findings: [] },
    });
    readPackage(
      project({ "is-number": "^8.0.0", mine: "workspace:*", local: "file:../x", cat: "catalog:" }),
    );
    expect(asked()).toBe("guard is-number@^8.0.0 --output-format json");
  });

  it("does not run the guard when nothing is new, for other packages' manifests, or when switched off", () => {
    const { readPackage, asked } = load({ status: 4, body: blockedReport });
    readPackage(project({ "is-number": "^7.0.0" }));
    readPackage({ name: "is-number", version: "7.0.0", dependencies: { lodahs: "^1.0.0" } });
    expect(asked()).toBeUndefined();

    process.env.AUTOREMEDIATOR_GUARD = "off";
    const off = load({ status: 4, body: blockedReport });
    expect(() => off.readPackage(project({ lodahs: "^1.0.0" }))).not.toThrow();
    expect(off.asked()).toBeUndefined();
  });

  it("logs warnings without stopping, and fails open when the guard cannot run", () => {
    const warned = load({ status: 3, body: { ...blockedReport, verdict: "warn" } });
    expect(() => warned.readPackage(project({ lodahs: "^1.0.0" }))).not.toThrow();
    expect(warned.logged.join("\n")).toContain("check lodahs@^1.0.0");

    const broken = load({ status: 1, body: {} });
    expect(() => broken.readPackage(project({ lodahs: "^1.0.0" }))).not.toThrow();
    expect(broken.logged.join("\n")).toContain("could not run");
  });

  it("says so, rather than staying silent, when there is no lockfile to compare with", () => {
    const { readPackage, logged, asked } = load({ status: 4, body: blockedReport }, { lock: null });
    expect(() => readPackage(project({ lodahs: "^1.0.0" }))).not.toThrow();
    expect(logged.join("\n")).toContain("no pnpm-lock.yaml");
    expect(asked()).toBeUndefined();
  });

  it("only passes the guard names and ranges it can quote safely", () => {
    const { readPackage, asked } = load({
      status: 0,
      body: { spec: "x", verdict: "allow", findings: [] },
    });
    readPackage(
      project({ good: "^1.0.0", spaced: ">=1 <2", "Bad;Name": "1.0.0", aliased: "npm:other@^2" }),
    );
    expect(asked()).toBe("guard good@^1.0.0 spaced aliased --output-format json");
  });
});
