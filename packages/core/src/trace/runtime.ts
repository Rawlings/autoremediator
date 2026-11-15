/**
 * The hook that runs inside the traced program. It records which installed packages get loaded
 * and, for packages it is asked to watch, how often their exported functions are called.
 *
 * Rules it keeps: it never changes what the program does (it observes, and wraps only on request),
 * it never throws into the host (every hook body is guarded and fails open), and it never writes to
 * stdout or stderr. All output goes to the JSONL file named by AUTOREMEDIATOR_TRACE_FILE.
 */
import { appendFileSync } from "node:fs";
import Module, { registerHooks } from "node:module";
import { setInterval as startInterval, setTimeout as startTimeout } from "node:timers";
import { isMainThread } from "node:worker_threads";

import { filePathOf, instrumentEsModule, type ReexportSelection } from "./esm-instrument.js";
import { locatePackageFile } from "./locate.js";
import {
  TRACE_ENV,
  type ModuleFormat,
  type TraceCallsRecord,
  type TracePackageRecord,
  type TraceProcessRecord,
} from "./types.js";
import { wrapFunction, wrapModuleExports, type Counter, type WrapSink } from "./wrap.js";

const REGISTRY = "autoremediator.trace";
/** Call counts are flushed this often; new packages and entries are flushed almost at once. */
const FLUSH_INTERVAL_MS = 500;
const DIRTY_FLUSH_DELAY_MS = 50;
const APP = "(app)";

interface PackageState {
  name: string;
  version: string;
  root: string;
  entries: Set<string>;
  dependents: Set<string>;
  formats: Set<ModuleFormat>;
  counters: Map<string, { counter: Counter; flushed: number }>;
  unwrapped: Map<string, string>;
  /** Something changed that the file does not have yet. */
  dirty: boolean;
}

type Parent = { filename?: string } | null | undefined;

/** The `Module` internals this hook patches. They have been stable across every Node release. */
interface PatchableModule {
  _load: (request: string, parent: Parent, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: Parent, isMain: boolean) => string;
  isBuiltin: (name: string) => boolean;
}

export interface TraceHookOptions {
  file: string;
  listed: ReadonlySet<string>;
  calls: boolean;
}

/** Read the hook's configuration from the environment; undefined when tracing is not requested. */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): TraceHookOptions | undefined {
  const file = env[TRACE_ENV.file];
  if (!file) return undefined;
  const listed = new Set(
    (env[TRACE_ENV.packages] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );
  return { file, listed, calls: env[TRACE_ENV.calls] === "1" && listed.size > 0 };
}

export function installTraceHook(options: TraceHookOptions): void {
  const globals = globalThis as Record<symbol, unknown>;
  const registryKey = Symbol.for(REGISTRY);
  if (globals[registryKey]) return;

  const packages = new Map<string, PackageState>();
  /** Resolved entry files of watched packages, so the load hook knows what to instrument. */
  const watchedEntries = new Set<string>();
  /** Files an entry re-exports from, with the exports that are visible through it. */
  const reexportTargets = new Map<string, ReexportSelection>();
  /** Who imported a file through the ES module hooks, for CommonJS loads that carry no parent. */
  const importers = new Map<string, string>();
  const noted = new Map<string, boolean>();
  let announced = false;
  let hooked = false;
  /** True while this hook itself loads code (its parser), which must not appear in the trace. */
  let internal = false;

  /**
   * Test runners end their workers abruptly, so a package seen for the first time is written within
   * a moment instead of waiting for exit. The timer is one-shot, unref'd and only set when needed.
   */
  let armed = false;
  const arm = (): void => {
    if (armed) return;
    armed = true;
    startTimeout(() => {
      armed = false;
      flush();
    }, DIRTY_FLUSH_DELAY_MS).unref();
  };

  const stateFor = (located: { root: string; name: string; version: string }): PackageState => {
    let state = packages.get(located.root);
    if (!state) {
      state = {
        name: located.name,
        version: located.version,
        root: located.root,
        entries: new Set(),
        dependents: new Set(),
        formats: new Set(),
        counters: new Map(),
        unwrapped: new Map(),
        dirty: true,
      };
      packages.set(located.root, state);
      arm();
    }
    return state;
  };

  const sinkFor = (state: PackageState): WrapSink => ({
    counter(name) {
      let entry = state.counters.get(name);
      if (!entry) {
        entry = { counter: { n: 0 }, flushed: 0 };
        state.counters.set(name, entry);
        state.dirty = true;
        arm();
      }
      return entry.counter;
    },
    skip(name, reason) {
      if (!state.unwrapped.has(name)) {
        state.unwrapped.set(name, reason);
        state.dirty = true;
        arm();
      }
    },
  });

  /** Note that `file` was loaded by `parentFile`; true when it is a package entry point. */
  const noteLoad = (file: string, parentFile: string | undefined): boolean => {
    if (internal || file.endsWith("package.json")) return false;
    const key = `${parentFile ?? ""}\0${file}`;
    const known = noted.get(key);
    if (known !== undefined) return known;
    const located = locatePackageFile(file);
    const parent = parentFile === undefined ? undefined : locatePackageFile(parentFile);
    const entry = located !== undefined && parent?.root !== located.root;
    noted.set(key, entry);
    if (located && entry) {
      const state = stateFor(located);
      state.entries.add(located.file);
      state.dependents.add(parent ? parent.name : APP);
      state.dirty = true;
      arm();
    }
    return entry;
  };

  const noteFormat = (file: string, format: string | null | undefined): void => {
    // A require() of a CommonJS file reports no format at all.
    const known: ModuleFormat | undefined =
      format === "module"
        ? "esm"
        : format === "commonjs" || (format == null && /\.c?js$/.test(file))
          ? "cjs"
          : undefined;
    if (!known || internal) return;
    const located = locatePackageFile(file);
    if (!located) return;
    const state = stateFor(located);
    if (!state.formats.has(known)) {
      state.formats.add(known);
      state.dirty = true;
      arm();
    }
  };

  const flush = (): void => {
    try {
      const lines: string[] = [];
      if (!announced) {
        announced = true;
        const proc: TraceProcessRecord = {
          v: 1,
          t: "proc",
          pid: process.pid,
          main: isMainThread,
          at: new Date().toISOString(),
          node: process.versions.node,
          calls: options.calls,
          listed: [...options.listed],
          observes: hooked ? "hooks" : "cjs-only",
        };
        lines.push(JSON.stringify(proc));
      }
      for (const state of packages.values()) {
        const calls: Record<string, number> = {};
        let moved = false;
        for (const [name, entry] of state.counters) {
          const delta = entry.counter.n - entry.flushed;
          if (delta > 0) {
            calls[name] = delta;
            entry.flushed = entry.counter.n;
            moved = true;
          }
        }
        if (!state.dirty && !moved) continue;
        state.dirty = false;
        const pkg: TracePackageRecord = {
          v: 1,
          t: "pkg",
          name: state.name,
          version: state.version,
          entries: [...state.entries],
          dependents: [...state.dependents],
          formats: [...state.formats],
        };
        lines.push(JSON.stringify(pkg));
        if (state.counters.size > 0 || state.unwrapped.size > 0) {
          const record: TraceCallsRecord = {
            v: 1,
            t: "calls",
            name: state.name,
            version: state.version,
            calls,
            wrapped: [...state.counters.keys()],
            unwrapped: Object.fromEntries(state.unwrapped),
          };
          lines.push(JSON.stringify(record));
        }
      }
      if (lines.length > 0) appendFileSync(options.file, `${lines.join("\n")}\n`);
    } catch {
      // The trace is best effort; a full disk or removed directory must not reach the program.
    }
  };

  const watched = (name: string): boolean => options.calls && options.listed.has(name);
  const patchable = Module as unknown as PatchableModule;

  /** CommonJS: observe every bare or absolute require and wrap the exports of watched packages. */
  const originalLoad = patchable._load;
  patchable._load = function patchedLoad(
    this: unknown,
    ...args: [string, Parent, boolean]
  ): unknown {
    const [request, parent, isMain] = args;
    let watchedEntry: PackageState | undefined;
    try {
      if (
        !isMain &&
        typeof request === "string" &&
        !request.startsWith(".") &&
        !request.startsWith("node:") &&
        !patchable.isBuiltin(request)
      ) {
        const filename = patchable._resolveFilename(request, parent, false);
        const located = locatePackageFile(filename);
        if (
          located &&
          noteLoad(filename, parent?.filename ?? importers.get(filename)) &&
          watched(located.name)
        ) {
          watchedEntry = stateFor(located);
          // Lets the ES module load hook instrument a package that is loaded with require(esm).
          watchedEntries.add(filename);
        }
      }
    } catch {
      // Resolution failures belong to the real loader below, which throws its own error.
    }
    // Errors from the real loader are the host's own and pass through unchanged.
    const exported = Reflect.apply(originalLoad, this, args);
    if (!watchedEntry) return exported;
    try {
      return wrapModuleExports(exported, sinkFor(watchedEntry));
    } catch {
      return exported;
    }
  };

  globals[registryKey] = {
    /** Called from instrumented ES modules: wrap a function and count calls under `names`. */
    wrap(value: unknown, names: string[], packageRoot: string): unknown {
      try {
        if (typeof value !== "function") return value;
        const state = packages.get(packageRoot);
        if (!state) return value;
        return wrapFunction(value as (...args: unknown[]) => unknown, names, sinkFor(state));
      } catch {
        return value;
      }
    },
  };

  if (typeof registerHooks === "function") {
    hooked = true;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        try {
          const file = filePathOf(result.url);
          // CommonJS requires are noted by the patched loader, which also sees the cache hits.
          if (file && !context.conditions.includes("require")) {
            const parentFile = context.parentURL ? filePathOf(context.parentURL) : undefined;
            if (parentFile) importers.set(file, parentFile);
            const located = locatePackageFile(file);
            if (located && noteLoad(file, parentFile) && watched(located.name)) {
              watchedEntries.add(file);
            }
          }
        } catch {
          // Fail open.
        }
        return result;
      },
      load(url, context, nextLoad) {
        const result = nextLoad(url, context);
        try {
          const file = filePathOf(url);
          if (!file) return result;
          noteFormat(file, result.format);
          if (!options.calls || result.format !== "module" || result.source == null) return result;
          const located = locatePackageFile(file);
          if (!located || !watched(located.name)) return result;
          const isEntry = watchedEntries.has(file);
          const visible = reexportTargets.get(file);
          if (!isEntry && !visible) return result;

          const raw = result.source;
          const text =
            typeof raw === "string"
              ? raw
              : ArrayBuffer.isView(raw)
                ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8")
                : Buffer.from(raw).toString("utf8");
          const state = stateFor(located);
          internal = true;
          let outcome: ReturnType<typeof instrumentEsModule>;
          try {
            outcome = instrumentEsModule(
              file,
              text,
              isEntry ? undefined : visible,
              REGISTRY,
              located.root,
            );
          } finally {
            internal = false;
          }
          for (const [target, selection] of outcome.reexports) {
            const existing = reexportTargets.get(target);
            if (!existing) {
              reexportTargets.set(target, selection);
              continue;
            }
            existing.all ||= selection.all;
            for (const [name, aliases] of selection.names) {
              const merged = existing.names.get(name) ?? new Set<string>();
              for (const alias of aliases) merged.add(alias);
              existing.names.set(name, merged);
            }
          }
          const sink = sinkFor(state);
          for (const [name, reason] of Object.entries(outcome.unwrapped)) sink.skip(name, reason);
          return outcome.source === undefined ? result : { ...result, source: outcome.source };
        } catch {
          return result;
        }
      },
    });
  }

  const flushTimer = startInterval(flush, FLUSH_INTERVAL_MS);
  flushTimer.unref();
  process.on("exit", flush);
}
