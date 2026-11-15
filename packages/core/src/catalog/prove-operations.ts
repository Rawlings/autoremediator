import { z } from "zod";

import { OPTION_DESCRIPTIONS, pathField } from "../platform/option-schemas.js";
import { defineOperation, type Operation } from "./define-operation.js";

const proveInput = z
  .object({
    cveId: z
      .string("cveId is required (string)")
      .min(1, "cveId is required (string)")
      .max(300)
      .describe(
        "The advisory to reproduce: a CVE, GHSA or OSV id. With advisoryText it may be any label.",
      ),
    package: z
      .string()
      .min(1)
      .max(214)
      .optional()
      .describe(
        "The npm package to prove against. Optional when the advisory affects exactly one package.",
      ),
    vulnerableVersion: z
      .string()
      .max(100)
      .optional()
      .describe(
        "Exact version the script must fail on. Default: the newest vulnerable version below the fix.",
      ),
    fixedVersion: z
      .string()
      .max(100)
      .optional()
      .describe(
        "Exact version the script must pass on. Default: the advisory's first patched version.",
      ),
    advisoryText: z
      .string()
      .max(20_000)
      .optional()
      .describe(
        "Describe the vulnerability yourself, instead of or in addition to what OSV says. Treated as data by the agent.",
      ),
    model: z.string().optional().describe(OPTION_DESCRIPTIONS.model),
    cwd: pathField(OPTION_DESCRIPTIONS.cwd).optional(),
    patchesDir: pathField(
      "Directory the kept script and its evidence record are written to (default: ./patches), where the existing proof-of-fix check looks for it.",
    ).optional(),
    signingKeyPath: pathField(
      "Ed25519 private key (PEM) to sign the evidence record with, as a detached DSSE signature next to it. Nothing is signed without it.",
    ).optional(),
    maxTrials: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Candidate scripts the agent may try. Default 4."),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(60_000)
      .optional()
      .describe("Wall-clock limit of one sandboxed run in milliseconds. Default 10000."),
  })
  .strict();

export const PROVE_OPERATIONS: readonly Operation[] = [
  defineOperation({
    name: "generateProofOfFix",
    title: "Generate exploit-proof evidence",
    description:
      "An agent writes a small Node.js reproduction of an advisory's vulnerability, and it is kept only if a deterministic harness proves it: in a sandbox (Node permission model: no network, no child processes, no file access outside its directory, empty environment, timeout, output cap) it must FAIL against the vulnerable version and PASS against the fixed version, both installed from integrity-verified registry tarballs, repeatably. The kept script is written to the patches directory where the proofOfFix check finds it, with a JSON evidence record and, if signingKeyPath is given, a detached Ed25519 DSSE signature. Needs a model (model or AUTOREMEDIATOR_MODEL) and the network. The harness shows the script tells the two versions apart through the package's API, not that the difference is the advisory's vulnerability; review the script.",
    input: proveInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    response: {
      description: "ProveResult",
      schema: {
        type: "object",
        properties: {
          schemaVersion: { type: "string" },
          advisoryId: { type: "string" },
          package: { type: "string" },
          vulnerableVersion: { type: "string" },
          fixedVersion: { type: "string" },
          status: { type: "string", enum: ["kept", "rejected"] },
          reason: { type: "string" },
          trials: { type: "array", items: { type: "object" } },
          agent: { type: "object" },
          usage: { type: "array", items: { type: "object" } },
          files: { type: "object" },
          evidence: { type: "object" },
          sandbox: { type: "object" },
        },
      },
    },
    mcp: true,
    http: { method: "POST", path: "/proof-of-fix/generate", positional: ["cveId"] },
    handler: ({ cveId, ...options }, context) => context.api.generateProofOfFixFn(cveId, options),
  }),
];
