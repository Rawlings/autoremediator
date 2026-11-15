import type { ProductIdentity } from "./sbom.js";
import type { EvidencePackResult } from "./types.js";

/** The `README.md` of a pack: what it is, what it is not, what is in it, and how to check it. */
export function renderReadme(result: EvidencePackResult, product: ProductIdentity): string {
  const status = result.vex.byStatus;
  const reports = result.craReports;
  const lines = [
    `# Evidence pack for ${product.name}${product.version ? ` ${product.version}` : ""}`,
    "",
    "> **This is evidence assembled by a tool, not legal advice and not a compliance claim.**",
    "> autoremediator built it from files on one machine: the lockfile, the project's policy file and",
    "> the runs it recorded under `.autoremediator/runs/`. No person has reviewed it, nothing in it",
    "> was fetched from the network now, and nothing was submitted to anyone. Whether it satisfies",
    "> Regulation (EU) 2024/2847 for your product is for you, your notified body or your counsel to decide.",
    "",
    `Generated ${result.generatedAt}.`,
    "",
    `Attestations: **${result.signed ? `signed (key id ${result.signingKeyId}, ${result.signingAlgorithm})` : "UNSIGNED (`signed: false`; the envelopes have an empty `signatures` list)"}**.`,
    "",
    "## Contents",
    "",
    "| File | What it is |",
    "| ---- | ---------- |",
    `| \`${result.sbom.file}\` | CycloneDX 1.6 SBOM from ${result.sbom.source}: ${result.sbom.components} components, ${result.sbom.withHash} with a hash, ${result.sbom.withLicense} with a license, and the dependency graph. |`,
    `| \`${result.vex.cycloneDxFile}\` | CycloneDX 1.6 VEX: ${result.vex.statements} vulnerability statements with \`affects\` (fixed ${status.fixed}, affected ${status.affected}, not affected ${status.not_affected}, under investigation ${status.under_investigation}). |`,
    `| \`${result.vex.openVexFile}\` | The same statements as an OpenVEX v0.2.0 document. |`,
    `| \`cra-reports/\` | ${
      reports.length === 0
        ? "None: no recorded advisory is both listed in the CISA KEV catalog and recorded as affecting the product."
        : `${reports.length} DRAFT Article 14 report${reports.length === 1 ? "" : "s"}, one per actively exploited advisory (${reports.map((report) => report.cveId).join(", ")}).`
    } |`,
    `| \`attestations/run-*.intoto.json\` | ${result.attestations.length} DSSE envelope${result.attestations.length === 1 ? "" : "s"} holding an in-toto statement about a recorded run's hash-chained ledger. \`*.statement.json\` is the bare statement, the exact bytes that were enveloped. |`,
    "| `manifest.json` | sha256 and size of every file above. |",
    "| `attestations/pack.intoto.json` | An attestation whose subject is `manifest.json`, so one signature covers the whole pack. |",
    ...(result.signed
      ? [
          "| `attestations/signing-public-key.pem` | The public key of the signing key. Trust it only if you got it from the signer by another route. |",
        ]
      : []),
    "",
    "## Check it",
    "",
    "```bash",
    "autoremediator evidence-pack verify . --public-key <the signer's public key>   # digests and signatures",
    "```",
    "",
    "Without autoremediator, the digests can be checked against `manifest.json` with any sha256 tool.",
    "An unsigned pack shows the files are unchanged since the manifest was written; it cannot show who wrote them.",
    "",
    "## Notes from this run",
    "",
    ...(result.notes.length > 0 ? result.notes.map((note) => `- ${note}`) : ["- None."]),
    "",
    "See `docs/guides/evidence-pack.md` in the autoremediator repository for what each document claims, what it does not, and the sources.",
    "",
  ];
  return lines.join("\n");
}
