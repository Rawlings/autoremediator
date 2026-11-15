import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Test helpers: fake installed packages and OpenVEX documents. Not imported by production code. */

export interface FakePackage {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  /** Value of package.json#vex. */
  vex?: unknown;
  /** Files to write inside the package: path to content. */
  files?: Record<string, string>;
  /** Directory under node_modules to install into (default: node_modules/<name>). */
  at?: string;
}

export function installFake(cwd: string, pkg: FakePackage): string {
  const dir = pkg.at ?? join(cwd, "node_modules", pkg.name);
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = {
    name: pkg.name,
    version: pkg.version,
    ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
    ...(pkg.vex === undefined ? {} : { vex: pkg.vex }),
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
  for (const [path, content] of Object.entries(pkg.files ?? {})) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

export interface FakeStatement {
  vulnerability: string;
  aliases?: string[];
  status?: string;
  justification?: string | null;
  impact?: string;
  /** Product purl; default the maintainer's name@version. */
  product?: string;
  subcomponents?: string[];
  timestamp?: string;
  version?: number;
}

export function vexDocument(
  maintainer: { name: string; version: string },
  statements: FakeStatement[],
  overrides: Record<string, unknown> = {},
): string {
  const encode = (name: string) => (name.startsWith("@") ? `%40${name.slice(1)}` : name);
  const doc = {
    "@context": "https://openvex.dev/ns/v0.2.0",
    "@id": `https://example.test/vex/${maintainer.name}-${maintainer.version}`,
    author: "Maintainer <maintainer@example.test>",
    timestamp: "2026-01-01T00:00:00Z",
    version: 1,
    statements: statements.map((statement) => {
      const purl = statement.product ?? `pkg:npm/${encode(maintainer.name)}@${maintainer.version}`;
      return {
        vulnerability: {
          name: statement.vulnerability,
          ...(statement.aliases ? { aliases: statement.aliases } : {}),
        },
        products: [
          {
            "@id": purl,
            ...(statement.subcomponents
              ? { subcomponents: statement.subcomponents.map((sub) => ({ "@id": sub })) }
              : {}),
          },
        ],
        status: statement.status ?? "not_affected",
        ...(statement.justification === null
          ? {}
          : { justification: statement.justification ?? "vulnerable_code_not_in_execute_path" }),
        ...(statement.impact ? { impact_statement: statement.impact } : {}),
        ...(statement.timestamp ? { timestamp: statement.timestamp } : {}),
        ...(statement.version === undefined ? {} : { version: statement.version }),
      };
    }),
    ...overrides,
  };
  return JSON.stringify(doc, null, 2);
}
