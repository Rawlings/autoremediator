import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProjectLocks } from "../../incident/project.js";
import type { SbomEntry } from "../../remediate/types.js";
import type { LockGraph } from "../../scan/lock-graph/index.js";
import {
  factKey,
  hashFromIntegrity,
  installedLicense,
  licenseChoice,
  npmPurl,
  readLockFacts,
  splitName,
  type CycloneDxHash,
  type CycloneDxLicenseChoice,
  type LockedPackageFacts,
} from "./components.js";

export interface ProductIdentity {
  name: string;
  version?: string;
  description?: string;
  purl?: string;
  manufacturer?: string;
}

export interface CycloneDxComponent {
  type: "library" | "application";
  "bom-ref": string;
  group?: string;
  name: string;
  version?: string;
  description?: string;
  scope?: "required" | "optional" | "excluded";
  purl?: string;
  hashes?: CycloneDxHash[];
  licenses?: CycloneDxLicenseChoice[];
  properties?: Array<{ name: string; value: string }>;
}

export interface CycloneDxBom {
  bomFormat: "CycloneDX";
  specVersion: "1.6";
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    lifecycles: Array<{ phase: "pre-build" }>;
    tools: { components: CycloneDxComponent[] };
    component: CycloneDxComponent;
    manufacturer?: { name: string };
    properties: Array<{ name: string; value: string }>;
  };
  components: CycloneDxComponent[];
  dependencies: Array<{ ref: string; dependsOn: string[] }>;
}

export interface SbomBuild {
  bom: CycloneDxBom;
  /** Which lockfile the components came from, or `report` when only a run report's SBOM was available. */
  source: string;
  componentCount: number;
  withHash: number;
  withLicense: number;
  /** `name@version` of every component, for later lookups. */
  locked: Set<string>;
  notes: string[];
}

/** The identity of the product from `package.json`, overridden by what the caller states. */
export function productIdentity(
  cwd: string,
  overrides: { name?: string; version?: string; manufacturer?: string },
): ProductIdentity {
  let manifest: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null) manifest = parsed as Record<string, unknown>;
  } catch {
    // No readable package.json: the caller must name the product.
  }
  const name =
    overrides.name ?? (typeof manifest["name"] === "string" ? manifest["name"] : "unnamed-product");
  const version =
    overrides.version ??
    (typeof manifest["version"] === "string" ? manifest["version"] : undefined);
  return {
    name,
    ...(version ? { version } : {}),
    ...(typeof manifest["description"] === "string"
      ? { description: manifest["description"] }
      : {}),
    // Only a package.json-style identity has a purl; a free-text product name does not.
    ...(version && /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/.test(name)
      ? { purl: npmPurl(name, version) }
      : {}),
    ...(overrides.manufacturer ? { manufacturer: overrides.manufacturer } : {}),
  };
}

/** Production reachability per node id: reachable from a production root, a dev root, or neither. */
function reachability(graph: LockGraph): Map<string, "prod" | "dev"> {
  const result = new Map<string, "prod" | "dev">();
  const walk = (starts: string[], kind: "prod" | "dev"): void => {
    const stack = [...starts];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const seen = result.get(id);
      if (seen === "prod" || seen === kind) continue;
      result.set(id, kind);
      for (const dep of graph.nodes.get(id)?.deps ?? []) stack.push(dep);
    }
  };
  // Production first, so a package both kinds reach stays `prod`.
  for (const root of graph.roots) walk(root.prod, "prod");
  for (const root of graph.roots) walk(root.dev, "dev");
  return result;
}

const toolComponent = (toolVersion: string): CycloneDxComponent => ({
  type: "application",
  "bom-ref": "autoremediator",
  name: "autoremediator",
  version: toolVersion,
});

/**
 * A CycloneDX 1.6 SBOM of what the project's lockfile locks: every package as a component with a
 * purl, a hash where the lockfile records an integrity digest, a license where the lockfile or the
 * installed copy declares one, and the dependency graph. When no lockfile can be read, the packages
 * of a recorded run's report SBOM are listed instead, without a graph.
 */
export function buildSbom(input: {
  cwd: string;
  product: ProductIdentity;
  locks: ProjectLocks;
  /** Status the pipeline recorded per `name@version` in run reports. */
  reportEntries: Map<string, SbomEntry>;
  toolVersion: string;
  now: Date;
}): SbomBuild {
  const { cwd, product, locks, reportEntries } = input;
  const notes: string[] = [...locks.notes];
  const chosen = locks.locks[0];
  if (locks.locks.length > 1) {
    notes.push(
      `More than one lockfile was found (${locks.locks.map((lock) => lock.path).join(", ")}); the SBOM follows ${chosen!.path}.`,
    );
  }

  const productRef =
    product.purl ?? `product:${product.name}${product.version ? `@${product.version}` : ""}`;
  const productComponent: CycloneDxComponent = {
    type: "application",
    "bom-ref": productRef,
    ...splitName(product.name),
    ...(product.version ? { version: product.version } : {}),
    ...(product.description ? { description: product.description } : {}),
    ...(product.purl ? { purl: product.purl } : {}),
  };

  const components = new Map<string, CycloneDxComponent>();
  const dependsOn = new Map<string, Set<string>>();
  const locked = new Set<string>();
  let source: string;

  const facts = new Map<string, LockedPackageFacts>();
  if (chosen) {
    source = chosen.path;
    try {
      for (const [key, value] of readLockFacts(
        chosen.path,
        readFileSync(join(cwd, chosen.path), "utf8"),
      )) {
        facts.set(key, value);
      }
    } catch {
      notes.push(`${chosen.path} could not be read again for hashes; components have none.`);
    }
    const reach = reachability(chosen.graph);
    for (const node of chosen.graph.nodes.values()) {
      const purl = npmPurl(node.name, node.version);
      const found = facts.get(factKey(node.name, node.version));
      const hash = found?.integrity ? hashFromIntegrity(found.integrity) : undefined;
      const licenseText = found?.license ?? installedLicense(cwd, node.name, node.version);
      const license = licenseText ? licenseChoice(licenseText) : undefined;
      const kind = reach.get(node.id);
      const existing = components.get(purl);
      if (!existing) {
        const report = reportEntries.get(factKey(node.name, node.version));
        const properties = [
          ...(report?.scope
            ? [{ name: "autoremediator:dependency-scope", value: report.scope }]
            : []),
          ...(report?.status
            ? [{ name: "autoremediator:remediation-status", value: report.status }]
            : []),
          ...(report?.cveIds?.length
            ? [{ name: "autoremediator:cve-ids", value: report.cveIds.toSorted().join(",") }]
            : []),
        ];
        components.set(purl, {
          type: "library",
          "bom-ref": purl,
          ...splitName(node.name),
          version: node.version,
          ...(kind
            ? { scope: kind === "prod" ? ("required" as const) : ("excluded" as const) }
            : {}),
          purl,
          ...(hash ? { hashes: [hash] } : {}),
          ...(license ? { licenses: [license] } : {}),
          ...(properties.length > 0 ? { properties } : {}),
        });
        dependsOn.set(purl, new Set());
      } else if (kind === "prod" && existing.scope === "excluded") {
        existing.scope = "required";
      }
      locked.add(factKey(node.name, node.version));
    }
    for (const node of chosen.graph.nodes.values()) {
      const from = npmPurl(node.name, node.version);
      for (const depId of node.deps) {
        const dep = chosen.graph.nodes.get(depId);
        if (!dep) continue;
        const to = npmPurl(dep.name, dep.version);
        if (to !== from) dependsOn.get(from)?.add(to);
      }
    }
    const rootDeps = new Set<string>();
    for (const root of chosen.graph.roots) {
      for (const id of [...root.prod, ...root.dev]) {
        const node = chosen.graph.nodes.get(id);
        if (node) rootDeps.add(npmPurl(node.name, node.version));
      }
    }
    dependsOn.set(productRef, rootDeps);
    if (chosen.graph.roots.length === 0) {
      notes.push(
        "The lockfile did not say which packages the project depends on directly, so the product has no direct dependencies in the graph.",
      );
    }
  } else {
    source = "report";
    for (const entry of reportEntries.values()) {
      const purl = npmPurl(entry.name, entry.version);
      components.set(purl, {
        type: "library",
        "bom-ref": purl,
        ...splitName(entry.name),
        version: entry.version,
        purl,
        properties: [
          { name: "autoremediator:dependency-scope", value: entry.scope },
          ...(entry.status
            ? [{ name: "autoremediator:remediation-status", value: entry.status }]
            : []),
        ],
      });
      locked.add(factKey(entry.name, entry.version));
    }
    notes.push(
      components.size > 0
        ? "No lockfile could be read; the components come from the SBOM recorded in run reports, with no dependency graph, hashes or licenses."
        : "No lockfile could be read and no run report carries an SBOM, so the SBOM has no components.",
    );
    dependsOn.set(productRef, new Set());
  }

  const sorted = [...components.values()].toSorted((a, b) =>
    a["bom-ref"].localeCompare(b["bom-ref"]),
  );
  const dependencies = [
    { ref: productRef, dependsOn: [...(dependsOn.get(productRef) ?? [])].toSorted() },
    ...sorted.map((component) => ({
      ref: component["bom-ref"],
      dependsOn: [...(dependsOn.get(component["bom-ref"]) ?? [])].toSorted(),
    })),
  ];

  const bom: CycloneDxBom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: input.now.toISOString(),
      lifecycles: [{ phase: "pre-build" }],
      tools: { components: [toolComponent(input.toolVersion)] },
      component: productComponent,
      ...(product.manufacturer ? { manufacturer: { name: product.manufacturer } } : {}),
      properties: [{ name: "autoremediator:component-source", value: source }],
    },
    components: sorted,
    dependencies,
  };

  return {
    bom,
    source,
    componentCount: sorted.length,
    withHash: sorted.filter((component) => component.hashes).length,
    withLicense: sorted.filter((component) => component.licenses).length,
    locked,
    notes,
  };
}
