import { z } from "zod";

import { OPTION_DESCRIPTIONS, pathField } from "../platform/option-schemas.js";
import { defineOperation, type Operation } from "./define-operation.js";

const timestamp = (what: string) =>
  z
    .string()
    .min(1)
    .max(64)
    .describe(`${what} ISO 8601 with a time zone (Z or an offset), e.g. 2026-11-10T14:30:00Z.`);

const buildEvidencePackInput = z
  .object({
    outDir: pathField(
      "Directory to write the evidence pack into (created if needed). Must be empty, absent, or hold an earlier pack; nothing outside it is written.",
    ),
    cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
    runIds: z
      .array(z.string().min(1).max(100))
      .max(500)
      .optional()
      .describe("Recorded runs to include. Default: every run under .autoremediator/runs/."),
    policy: pathField(
      "Policy file whose suppressions become VEX statements. Default: .github/autoremediator.yml.",
    ).optional(),
    productName: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Product name. Default: name from package.json."),
    productVersion: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Product version. Default: version from package.json."),
    manufacturer: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Manufacturer name for the SBOM metadata, the OpenVEX author and the reporting drafts.",
      ),
    author: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("OpenVEX document author. Default: a marked, unreviewed draft."),
    awarenessAt: timestamp(
      "When the manufacturer became aware that an advisory is being actively exploited. Starts the 24 hour and 72 hour clocks in the reporting drafts; without it they state the rules and no dates.",
    ).optional(),
    awarenessByCve: z
      .record(z.string().min(1).max(100), timestamp("Awareness time for that advisory."))
      .optional()
      .describe("Awareness time per advisory id, when it differs from awarenessAt."),
    correctiveMeasureAt: timestamp(
      "When a corrective or mitigating measure became available to users. Starts the 14 day final report clock.",
    ).optional(),
    signingKeyPath: pathField(
      "PEM private key file (Ed25519 or ECDSA P-256/P-384) to sign the attestations with. A path only: key material is never accepted. Without it the attestations are unsigned (signed: false). The CLI and SDK also read AUTOREMEDIATOR_EVIDENCE_SIGNING_KEY; MCP and HTTP callers must pass this.",
    ).optional(),
  })
  .strict();

export const EVIDENCE_PACK_OPERATIONS: readonly Operation[] = [
  defineOperation({
    name: "buildEvidencePack",
    title: "Build an EU Cyber Resilience Act evidence pack",
    description:
      "Assemble a reviewable evidence bundle from local data, for a manufacturer to hand to an auditor. Writes, under outDir only: a CycloneDX 1.6 SBOM of the lockfile (purls, hashes, licenses, dependency graph); VEX as CycloneDX 1.6 (with affects) and OpenVEX 0.2.0, from policy suppressions and recorded runs read against the lockfile; DRAFT Article 14 early-warning, notification and final-report texts for advisories recorded as CISA-KEV-listed and affecting the product, with deadlines computed from awarenessAt; DSSE/in-toto attestations of each recorded run's hash-chained ledger, signed only when signingKeyPath is given (otherwise signed: false); and a manifest of sha256 digests. This is evidence assembly, not legal advice or a compliance claim, and nothing is submitted anywhere. Reads the project and run records; no network. Changes nothing outside outDir.",
    input: buildEvidencePackInput,
    // Replaces an earlier pack in outDir (only the files that pack listed, and only if unchanged).
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    response: {
      description: "EvidencePackResult",
      schema: {
        type: "object",
        properties: {
          schemaVersion: { type: "string" },
          outDir: { type: "string" },
          generatedAt: { type: "string" },
          disclaimer: { type: "string" },
          signed: { type: "boolean" },
          signingKeyId: { type: "string" },
          files: { type: "array", items: { type: "object" } },
          manifest: { type: "object" },
          packAttestation: { type: "object" },
          sbom: { type: "object" },
          vex: { type: "object" },
          craReports: { type: "array", items: { type: "object" } },
          attestations: { type: "array", items: { type: "object" } },
          skippedRuns: { type: "array", items: { type: "object" } },
          notes: { type: "array", items: { type: "string" } },
        },
      },
    },
    mcp: true,
    http: { method: "POST", path: "/evidence-pack", positional: [] },
    handler: (options, context) =>
      context.api.buildEvidencePackFn({ ...options, source: context.source }),
  }),
];
