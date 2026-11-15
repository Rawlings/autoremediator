import type { RuntimeReachability } from "../platform/types.js";
import type { TracePackage, TraceReport } from "./types.js";

const CAVEAT =
  "This reflects only the code the traced command ran. Code it did not exercise is not covered, so this is evidence about the tests, not proof about production.";

/** `lib/template.js` and `template/index.js` both name the module `template`. */
function moduleNameOf(entry: string): string {
  const parts = entry.replace(/\.[cm]?[jt]s$/, "").split("/");
  const last = parts.at(-1);
  return last === "index" ? (parts.at(-2) ?? "index") : (last ?? entry);
}

/**
 * Calls counted for `symbol`. A package whose entry file is a single function (`lodash/template`,
 * `module.exports = template`) records those calls as `default`, so `default` counts for the symbol
 * when an entry file is named after it.
 */
function callsFor(pkg: TracePackage, symbol: string): number {
  const calls = pkg.calls ?? {};
  let count = calls[symbol] ?? 0;
  if (pkg.entries.some((entry) => moduleNameOf(entry) === symbol)) count += calls.default ?? 0;
  return count;
}

function unwrappedReason(pkg: TracePackage, symbol: string): string | undefined {
  const skipped = pkg.unwrapped ?? {};
  if (skipped[symbol]) return `${symbol}: ${skipped[symbol]}`;
  if (skipped.default && pkg.entries.some((entry) => moduleNameOf(entry) === symbol)) {
    return `default: ${skipped.default}`;
  }
  return undefined;
}

/**
 * The runtime verdict for one package from a folded trace. Absence from a trace is never reported
 * as "unreachable": the verdicts say what the traced run did, and the caveat says what that is not.
 */
export function assessRuntimeReachability(
  report: TraceReport,
  packageName: string,
  symbol?: string,
): RuntimeReachability {
  const exitCode = report.command?.exitCode;
  const base = { caveat: CAVEAT, ...(report.command ? { exitCode } : {}) };

  if (report.processes === 0) {
    return {
      ...base,
      verdict: "no-trace-data",
      reason:
        "The trace holds no process records, so the trace hook never ran (is it loaded with --import autoremediator/trace and is AUTOREMEDIATOR_TRACE_FILE set?). Nothing can be concluded.",
    };
  }

  const loaded = report.packages.filter(
    (pkg) => pkg.name === packageName && pkg.entries.length > 0,
  );
  const failed =
    exitCode !== undefined && exitCode !== 0
      ? ` The traced command exited ${String(exitCode)}, so it may have stopped before reaching this package.`
      : "";
  const esmGap = report.partialEsm
    ? " Some processes ran on a Node.js version that could not observe ES module imports."
    : "";

  if (loaded.length === 0) {
    return {
      ...base,
      verdict: "not-loaded-in-tests",
      reason: `'${packageName}' was not loaded by the traced command.${failed}${esmGap}`,
    };
  }

  const versions = loaded.map((pkg) => pkg.version).toSorted((a, b) => a.localeCompare(b));
  const loadedBy = [...new Set(loaded.flatMap((pkg) => pkg.dependents))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const found = { ...base, versions, loadedBy };
  const loadedText = `'${packageName}' (${versions.join(", ")}) was loaded by ${loadedBy.join(", ")}.`;

  const traced = report.callTracing.enabled && report.callTracing.packages.includes(packageName);
  if (!traced) {
    return {
      ...found,
      verdict: "loaded-in-tests",
      reason: symbol
        ? `${loadedText} Calls were not counted for this package; re-run with --packages ${packageName} --calls to see whether '${symbol}' is called.`
        : loadedText,
    };
  }

  if (symbol === undefined) {
    const total = loaded.reduce(
      (sum, pkg) => sum + Object.values(pkg.calls ?? {}).reduce((a, b) => a + b, 0),
      0,
    );
    return total > 0
      ? {
          ...found,
          verdict: "called-in-tests",
          reason: `${loadedText} Its exports were called ${String(total)} time(s).`,
          calls: { count: total },
        }
      : {
          ...found,
          verdict: "loaded-not-called-in-tests",
          reason: `${loadedText} None of its exported functions were called.${failed}`,
          calls: { count: 0 },
        };
  }

  const count = loaded.reduce((sum, pkg) => sum + callsFor(pkg, symbol), 0);
  if (count > 0) {
    return {
      ...found,
      verdict: "called-in-tests",
      reason: `${loadedText} '${symbol}' was called ${String(count)} time(s).`,
      calls: { symbol, count },
    };
  }
  const skipped = loaded.map((pkg) => unwrappedReason(pkg, symbol)).find((reason) => reason);
  if (skipped) {
    return {
      ...found,
      verdict: "loaded-in-tests",
      reason: `${loadedText} Calls to '${symbol}' could not be counted (${skipped}).`,
    };
  }
  return {
    ...found,
    verdict: "loaded-not-called-in-tests",
    reason: `${loadedText} '${symbol}' was never called through the package's entry points.${failed} Only calls through the package's exported functions are counted; see docs/guides/runtime-reachability.md for what is skipped.`,
    calls: { symbol, count: 0 },
  };
}
