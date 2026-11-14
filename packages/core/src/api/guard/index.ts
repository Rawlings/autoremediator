import { evaluatePackage } from "../../remediation/evaluate-package.js";
import { queryOsvPackage } from "../../intelligence/sources/osv.js";
import { readCooldown, withCooldown } from "../../platform/cooldown.js";
import { httpClient } from "../../platform/http-client.js";
import { detectPackageManager } from "../../platform/package-manager/index.js";
import { loadRegistryConfig, packumentUrl } from "../../platform/registry-config.js";
import { judgePackument, resolveVersion, verdictOf, type Packument } from "./checks.js";
import { findLookalike } from "./popular.js";
import { parsePackageSpec } from "./spec.js";
import type { GuardAlternative, GuardFinding, GuardOptions, GuardReport } from "./types.js";

export { extractInstallSpecs, parsePackageSpec } from "./spec.js";
export type { GuardFinding, GuardOptions, GuardReport, GuardVerdict } from "./types.js";

/** Lookups the guard performs; replaceable so tests and embedders need no network. */
export interface GuardDeps {
  fetchPackument(name: string, cwd: string | undefined): Promise<Packument | undefined>;
  osvIds(name: string, version: string): Promise<string[]>;
  evaluate: typeof evaluatePackage;
  now(): number;
}

export const defaultGuardDeps: GuardDeps = {
  async fetchPackument(name, cwd) {
    const registry = loadRegistryConfig(cwd);
    const url = packumentUrl(registry, name);
    // The full document: the abbreviated one carries no publish times and no scripts.
    const res = await httpClient({
      url,
      headers: { Accept: "application/json", ...registry.headersFor(url) },
      timeout: 20_000,
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`registry answered ${res.status}`);
    return res.data as Packument;
  },
  async osvIds(name, version) {
    return (await queryOsvPackage(name, version)).map((vuln) => vuln.id);
  },
  evaluate: evaluatePackage,
  now: () => Date.now(),
};

/** Default minimum release age when the caller sets none. */
export const DEFAULT_MIN_AGE_HOURS = 72;

/**
 * The minimum release age to enforce for one package: what the caller asked for, else the larger of
 * the default and the project's own package manager cooldown (a version younger than that cooldown
 * would fail to install anyway). A caller-supplied value, including 0, is used as given.
 */
export function minAgeHoursFor(name: string, options: GuardOptions): number {
  if (options.minPublishAgeHours !== undefined) return options.minPublishAgeHours;
  const cwd = options.cwd ?? process.cwd();
  try {
    const cooldown = readCooldown(cwd, detectPackageManager(cwd));
    return withCooldown({ minPublishAgeHours: DEFAULT_MIN_AGE_HOURS }, cooldown, name)?.minPublishAgeHours ?? DEFAULT_MIN_AGE_HOURS;
  } catch {
    return DEFAULT_MIN_AGE_HOURS;
  }
}

function report(
  spec: string,
  findings: GuardFinding[],
  extra: Partial<GuardReport> = {},
  now = Date.now(),
): GuardReport {
  return {
    schemaVersion: "1.0",
    spec,
    verdict: verdictOf(findings),
    findings,
    ...extra,
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * Judge an npm package before it is installed: does it exist, is it known malware, does it imitate a
 * popular package, is the release suspiciously new, did it gain install scripts or lose provenance,
 * does it have known vulnerabilities. Reads the registry and OSV; installs nothing.
 *
 * A lookup that fails (registry or OSV unreachable) is reported as a warning, never as "all clear".
 */
export async function guardPackage(
  spec: string,
  options: GuardOptions = {},
  deps: GuardDeps = defaultGuardDeps,
): Promise<GuardReport> {
  const parsed = parsePackageSpec(spec);
  const now = deps.now();
  if (parsed.kind === "invalid") {
    return report(spec, [{ check: "spec", severity: "block", message: parsed.reason }], {}, now);
  }
  if (parsed.kind === "other") {
    return report(spec, [{ check: "spec", severity: "warn", message: parsed.reason }], {}, now);
  }

  const { name, range } = parsed;
  let packument: Packument | undefined;
  try {
    packument = await deps.fetchPackument(name, options.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return report(
      spec,
      [{ check: "registry", severity: "warn", message: `Could not read "${name}" from the registry (${message.slice(0, 120)}), so it was not checked.` }],
      { packageName: name },
      now,
    );
  }

  if (!packument) {
    const lookalike = findLookalike(name);
    return report(
      spec,
      [
        {
          check: "exists",
          severity: "block",
          message: `"${name}" does not exist on the registry. Assistants sometimes invent package names, and attackers register those names with malware.${lookalike ? ` Did you mean "${lookalike}"?` : ""}`,
        },
      ],
      {
        packageName: name,
        ...(lookalike ? { alternative: { packageName: lookalike, reason: "a widely used package with a similar name" } } : {}),
      },
      now,
    );
  }

  const version = resolveVersion(packument, range);
  if (!version || !packument.versions?.[version]) {
    return report(
      spec,
      [{ check: "exists", severity: "block", message: `No release of "${name}" matches "${range ?? "latest"}".` }],
      { packageName: name },
      now,
    );
  }

  const judged = judgePackument({
    packument: { ...packument, name },
    version,
    now,
    minPublishAgeHours: minAgeHoursFor(name, options),
  });
  const findings = [...judged.findings];
  let alternative: GuardAlternative | undefined = judged.alternative;

  if (options.offline) {
    findings.push({ check: "malware", severity: "info", message: "Offline: known-malware and advisory databases were not checked." });
  } else {
    try {
      const malware = (await deps.osvIds(name, version)).filter((id) => id.startsWith("MAL-"));
      if (malware.length > 0) {
        findings.push({
          check: "malware",
          severity: "block",
          message: `${name}@${version} is listed as malicious in the OSV malware feed (${malware.slice(0, 3).join(", ")}).`,
        });
      }
    } catch {
      findings.push({ check: "malware", severity: "warn", message: "The OSV malware feed could not be reached, so malware was not checked." });
    }

    try {
      const evaluation = await deps.evaluate(name, { version, cwd: options.cwd });
      const vulns = evaluation.vulnerabilities.filter((entry) => !entry.cveId.startsWith("MAL-"));
      if (vulns.length > 0 && evaluation.verdict !== "safe") {
        const worst = evaluation.verdict === "actively-exploited" ? "block" : evaluation.verdict === "vulnerable" ? "warn" : "info";
        findings.push({
          check: "vulnerabilities",
          severity: worst,
          message: `${name}@${version} has ${vulns.length} known ${vulns.length === 1 ? "vulnerability" : "vulnerabilities"} (${vulns.slice(0, 3).map((v) => v.cveId).join(", ")}${evaluation.verdict === "actively-exploited" ? "; at least one is being exploited" : ""}).`,
        });
        if (evaluation.recommendedVersion && evaluation.recommendedVersion !== version && !alternative) {
          alternative = { packageName: name, version: evaluation.recommendedVersion, reason: "a version without those vulnerabilities" };
        }
      }
    } catch {
      findings.push({ check: "vulnerabilities", severity: "warn", message: "Known vulnerabilities could not be looked up." });
    }
  }

  return report(spec, findings, { packageName: name, resolvedVersion: version, ...(alternative ? { alternative } : {}) }, now);
}

/** Guard several specs; reports come back in the order given. */
export async function guardPackages(specs: readonly string[], options: GuardOptions = {}): Promise<GuardReport[]> {
  return Promise.all(specs.map((spec) => guardPackage(spec, options)));
}
