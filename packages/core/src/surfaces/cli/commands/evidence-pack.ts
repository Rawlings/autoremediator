import type { Command } from "commander";

import {
  buildEvidencePack,
  OPTION_DESCRIPTIONS,
  verifyEvidencePack,
  type EvidencePackResult,
  type EvidencePackVerification,
} from "../../../api/index.js";
import { logJson } from "../output.js";
import { validateOutputFormat } from "../validators.js";

/** Same value as `SIGNING_KEY_ENV` in the SDK; spelled out so the CLI tests that mock `api/` need not know it. */
const SIGNING_KEY_ENV_NAME = "AUTOREMEDIATOR_EVIDENCE_SIGNING_KEY";

interface EvidencePackCliOptions {
  out?: string;
  cwd: string;
  run?: string[];
  policy?: string;
  productName?: string;
  productVersion?: string;
  manufacturer?: string;
  author?: string;
  awarenessAt?: string;
  awareness?: string[];
  correctiveMeasureAt?: string;
  signingKey?: string;
  outputFormat: string;
}

/** `CVE-2026-1=2026-11-10T14:30:00Z` pairs into a record; the time itself is validated by the SDK. */
function parseAwareness(entries: string[]): Record<string, string> {
  const byCve: Record<string, string> = {};
  for (const entry of entries) {
    const at = entry.indexOf("=");
    if (at <= 0 || at === entry.length - 1) {
      throw new Error(
        `--awareness expects <advisory-id>=<ISO 8601 time with zone>, not "${entry}".`,
      );
    }
    byCve[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return byCve;
}

function describePack(result: EvidencePackResult): string {
  const { byStatus } = result.vex;
  const lines = [
    `Evidence pack written to ${result.outDir}`,
    `  ${result.signed ? `attestations signed (key id ${result.signingKeyId}, ${result.signingAlgorithm})` : "attestations UNSIGNED (signed: false)"}`,
    `  SBOM: ${result.sbom.components} components from ${result.sbom.source} (${result.sbom.withHash} with hashes, ${result.sbom.withLicense} with licenses)`,
    `  VEX: ${result.vex.statements} statements (fixed ${byStatus.fixed}, affected ${byStatus.affected}, not affected ${byStatus.not_affected}, under investigation ${byStatus.under_investigation})`,
    `  Article 14 drafts: ${result.craReports.length}`,
    ...result.craReports.map(
      (report) =>
        `    ${report.cveId}${report.deadlines ? `: early warning due ${report.deadlines.earlyWarningDue}, notification due ${report.deadlines.notificationDue}` : ": no awareness time given, no deadlines computed"}`,
    ),
    `  Run attestations: ${result.attestations.length}`,
    ...result.notes.map((note) => `  note: ${note}`),
    "",
    "This is evidence assembly, not legal advice or a compliance claim. Nothing was submitted anywhere.",
  ];
  return `${lines.join("\n")}\n`;
}

export async function runEvidencePack(opts: EvidencePackCliOptions): Promise<void> {
  if (!opts.out)
    throw new Error("--out <dir> is required: the directory to write the evidence pack into.");
  const result = await buildEvidencePack({
    outDir: opts.out,
    cwd: opts.cwd,
    source: "cli",
    ...(opts.run && opts.run.length > 0 ? { runIds: opts.run } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.productName ? { productName: opts.productName } : {}),
    ...(opts.productVersion ? { productVersion: opts.productVersion } : {}),
    ...(opts.manufacturer ? { manufacturer: opts.manufacturer } : {}),
    ...(opts.author ? { author: opts.author } : {}),
    ...(opts.awarenessAt ? { awarenessAt: opts.awarenessAt } : {}),
    ...(opts.awareness && opts.awareness.length > 0
      ? { awarenessByCve: parseAwareness(opts.awareness) }
      : {}),
    ...(opts.correctiveMeasureAt ? { correctiveMeasureAt: opts.correctiveMeasureAt } : {}),
    ...(opts.signingKey ? { signingKeyPath: opts.signingKey } : {}),
  });
  if (opts.outputFormat === "json") logJson(result);
  else process.stdout.write(describePack(result));
}

function describeVerification(check: EvidencePackVerification): string {
  const lines = [
    check.ok ? "OK: every file matches the manifest." : "FAILED:",
    ...check.problems.map((problem) => `  ${problem}`),
    check.signaturesVerified
      ? "  signatures verified against the key you gave"
      : check.signed
        ? "  signatures NOT checked"
        : "  attestations are unsigned",
    ...check.notes.map((note) => `  note: ${note}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** Register `evidence-pack` and `evidence-pack verify`. */
export function registerEvidencePackCommands(program: Command): void {
  const pack = program
    .command("evidence-pack")
    .description(
      `EU Cyber Resilience Act evidence pack, assembled from local data: CycloneDX 1.6 SBOM, CycloneDX and OpenVEX VEX, DRAFT Article 14 reports for CISA-KEV advisories, and in-toto attestations of recorded runs (signed only with --signing-key or ${SIGNING_KEY_ENV_NAME}). Evidence assembly, not legal advice or a compliance claim; nothing is submitted`,
    )
    .option("--out <dir>", "Directory to write the pack into (empty, absent, or an earlier pack)")
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option(
      "--run <id>",
      "Include only this recorded run (repeatable; default: every run)",
      (value: string, previous?: string[]) => [...(previous ?? []), value],
    )
    .option("--policy <path>", "Policy file whose suppressions become VEX statements")
    .option("--product-name <name>", "Product name (default: name in package.json)")
    .option("--product-version <version>", "Product version (default: version in package.json)")
    .option(
      "--manufacturer <name>",
      "Manufacturer name for the SBOM, the OpenVEX author and the drafts",
    )
    .option("--author <name>", "OpenVEX document author (default: a marked, unreviewed draft)")
    .option(
      "--awareness-at <iso>",
      "When you became aware of active exploitation, ISO 8601 with a time zone; starts the 24h/72h clocks in the drafts",
    )
    .option(
      "--awareness <cve=iso>",
      "Awareness time for one advisory (repeatable; overrides --awareness-at)",
      (value: string, previous?: string[]) => [...(previous ?? []), value],
    )
    .option(
      "--corrective-measure-at <iso>",
      "When a corrective measure became available to users, ISO 8601 with a time zone; starts the 14 day final report clock",
    )
    .option(
      "--signing-key <pem>",
      `PEM private key file (Ed25519 or ECDSA P-256/P-384) to sign the attestations; default: the file named by ${SIGNING_KEY_ENV_NAME}, else unsigned`,
    )
    .option("--output-format <format>", "Output format: text|json", "text")
    .action(async (opts: EvidencePackCliOptions) => {
      validateOutputFormat(opts.outputFormat as "text" | "json", ["text", "json"], "evidence-pack");
      await runEvidencePack(opts);
    });

  pack
    .command("verify <dir>")
    .description(
      "Check a pack against its manifest (sha256 of every file) and, with --public-key, every attestation signature. The key inside the pack is never trusted",
    )
    .option("--public-key <pem>", "PEM public key the attestations must verify against")
    .option("--output-format <format>", "Output format: text|json", "text")
    .action((dir: string, opts: { publicKey?: string; outputFormat: string }) => {
      validateOutputFormat(
        opts.outputFormat as "text" | "json",
        ["text", "json"],
        "evidence-pack verify",
      );
      const check = verifyEvidencePack(
        dir,
        opts.publicKey ? { publicKeyPath: opts.publicKey } : {},
      );
      if (opts.outputFormat === "json") logJson(check);
      else process.stdout.write(describeVerification(check));
      process.exitCode = check.ok ? 0 : 1;
    });
}
