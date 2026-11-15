---
"autoremediator": minor
---

EU Cyber Resilience Act evidence pack: `autoremediator evidence-pack --out <dir>` assembles, from local data only, a bundle a manufacturer can hand to an auditor. It is evidence assembly, not legal advice or a compliance claim, and it submits nothing.

- **SBOM**: CycloneDX 1.6 from the lockfile (npm, pnpm, yarn classic, bun): purls, hashes from lockfile integrity digests, licenses where declared, scopes and the dependency graph.
- **VEX**: CycloneDX 1.6 (with `affects` by purl) and OpenVEX 0.2.0, from policy suppressions and recorded runs read against the current lockfile. Both are validated against the published JSON schemas in the tests.
- **Article 14 drafts**: for advisories a recorded run lists as CISA-KEV exploited and that affect the product, a markdown DRAFT of the early warning (24 hours), notification (72 hours) and final report (14 days after a corrective measure), pre-filled from local data, with every field the data cannot supply marked for the manufacturer. Deadlines are computed in UTC from `--awareness-at` (a time without a zone is refused); no dates are invented without it.
- **Attestations**: for each recorded run whose hash-chained ledger verifies, a DSSE envelope around an in-toto Statement v1 (subjects: manifests and lockfiles by sha256; predicate: plan items, outcomes, verifier results, ledger head hash). Unsigned by default (`signed: false`); signed with an Ed25519 or ECDSA P-256/P-384 PEM key from `--signing-key` or `AUTOREMEDIATOR_EVIDENCE_SIGNING_KEY` (CLI and SDK only). No Sigstore dependency.
- **Manifest** with the sha256 of every file, and `autoremediator evidence-pack verify <dir> [--public-key <pem>]` to check digests and signatures.
- Surfaces: CLI `evidence-pack` and `evidence-pack verify`, SDK `buildEvidencePack` / `verifyEvidencePack` / `craDeadlines` / `parseAwareness` / `pae`, MCP tool `buildEvidencePack`, HTTP `POST /evidence-pack`. Paths (`outDir`, `cwd`, `policy`, `signingKeyPath`) are confined to the allowed roots for remote callers; key material is never accepted inline.
- `toCycloneDxVex` and the `toVex` operation accept `specVersion: "1.6"` (default stays `1.5`): adds `affects` and uses CycloneDX-valid justifications.
- New guide `docs/guides/evidence-pack.md` with the sources and what the pack does not do. New dev dependencies `ajv` and `ajv-formats` (tests only).
