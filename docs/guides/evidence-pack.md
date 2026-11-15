# EU Cyber Resilience Act evidence pack

```bash
autoremediator evidence-pack --out compliance/evidence \
  --manufacturer "Example GmbH" \
  --awareness-at 2026-11-10T14:30:00Z \
  --signing-key ~/.keys/evidence-signing.pem
autoremediator evidence-pack verify compliance/evidence --public-key ~/.keys/evidence-signing.pub.pem
```

`evidence-pack` assembles, from data Autoremediator already has on the machine, a bundle a
manufacturer can hand to an auditor: an SBOM, vulnerability statements (VEX), draft reports for
actively exploited vulnerabilities, and attestations of the runs it recorded. It reads the project,
the lockfile, the policy file and `.autoremediator/runs/`. It uses no network and sends nothing
anywhere.

> **What this is not.** It is evidence assembly, not legal advice, not a conformity assessment and
> not a claim that any product complies with Regulation (EU) 2024/2847. Nobody has reviewed what it
> writes. The reporting drafts are drafts: you complete them and submit them yourself. Every
> generated file says so.

## What is in the pack

```
README.md                          what the pack is and is not, counts, notes from this run
manifest.json                      sha256 and size of every file below
sbom/sbom.cdx.json                 CycloneDX 1.6 SBOM
vex/vex.cdx.json                   CycloneDX 1.6 VEX, with affects
vex/vex.openvex.json               the same statements as OpenVEX v0.2.0
cra-reports/<advisory>.md          DRAFT Article 14 reports, one per actively exploited advisory
attestations/run-<runId>.intoto.json     DSSE envelope: in-toto statement about one recorded run
attestations/run-<runId>.statement.json  the bare statement (the exact bytes in the envelope)
attestations/pack.intoto.json      attestation whose subject is manifest.json
attestations/pack.statement.json   its bare statement
attestations/signing-public-key.pem      only when signed
```

### SBOM

CycloneDX 1.6, built from the project's lockfile (`package-lock.json`, `npm-shrinkwrap.json`,
`pnpm-lock.yaml`, `yarn.lock`, text `bun.lock`; the first one found, with a note when there are
several). Each package is a component with a purl (`pkg:npm/%40scope/name@1.2.3`), a hash when the
lockfile records an integrity digest (SHA-1, 256, 384 or 512, converted from the Subresource
Integrity string), a license when the lockfile or the installed copy in `node_modules` declares one
(an SPDX id or expression only when it is recognised, otherwise the declared text as a name), a
scope (`required` for what production reaches, `excluded` for development-only), and the dependency
graph. Yarn berry's `checksum` is not a Subresource Integrity digest and is not used. The status the
pipeline recorded for a package in run reports (`autoremediator:remediation-status`, `cve-ids`) is
added as properties. With no readable lockfile, the SBOM falls back to the packages in recorded run
reports, without a graph, hashes or licenses, and says so.

The CRA's Annex I Part II point 1 asks manufacturers to document the components of the product,
including an SBOM in a commonly used, machine-readable format covering at least the top-level
dependencies. An SBOM of the lockfile covers more than that; whether it is the right scope and
format for your product, and whether `devDependencies` belong in it, is your call.

### VEX

Statements come from two places only: the project's **policy suppressions** (`.github/autoremediator.yml`,
or `--policy`), and the **recorded runs** read against the lockfile as it is now. Nothing is looked
up and nothing is inferred beyond that.

| Situation | OpenVEX status | CycloneDX state |
| --------- | -------------- | --------------- |
| A recorded run applied the fix and the vulnerable version is no longer locked | `fixed` | `resolved` |
| A run planned an upgrade that was not applied, or no fix exists | `affected` with an `action_statement` | `exploitable` |
| The run applied a fix but the vulnerable version is locked again | `affected` | `exploitable` |
| The vulnerable version left the lockfile and no run fixed it | `not_affected`, `component_not_present` | `not_affected` |
| Policy suppression `not_affected` | `not_affected` with an `impact_statement` | `not_affected` |
| Policy suppression `mitigated` | `not_affected`, `inline_mitigations_already_exist` | `not_affected`, `protected_by_mitigating_control` |
| Policy suppression `fixed` | `fixed` | `resolved` |
| Policy suppression `under_investigation` | `under_investigation` | `in_triage` |

A suppression is a statement the project made; the pack records it as such ("asserted in the
project's policy file, not verified by autoremediator"). Expired suppressions are left out. A run
whose ledger fails verification contributes nothing as "applied". Reachability is a heuristic and
never becomes `not_affected`.

CycloneDX statements carry `affects` with the component's purl. The document lists the components
it refers to, so it stands alone. In OpenVEX the product is your product (its purl when
`package.json` gives a name and version) and the affected or fixed dependency is the subcomponent.
The OpenVEX `author` is `--author`, else `--manufacturer`, else a marked "unreviewed draft"; set it
to a real author before publishing.

`toCycloneDxVex` (and the MCP and HTTP operation `toVex`) also takes `specVersion: "1.6"`. The
default stays `1.5`, unchanged. Version 1.6 adds `affects` and replaces policy justifications the
CycloneDX schema does not define (`mitigated`, `fixed`, `under_investigation`) with the values it
does. The 1.5 output keeps emitting them as before, so a strict CycloneDX validator rejects its
`justification` field for suppressed advisories; use `1.6` where validity matters. The CLI's
`--output-format vex` stays on 1.5.

### Article 14 drafts

For every advisory a recorded run lists as **known exploited** (CISA KEV, from the run's advisory
lookup; nothing is fetched now) that a finding says affects the product, `cra-reports/<id>.md`
holds a draft of the three reports Article 14(2) describes for an actively exploited vulnerability:

| Stage | Article | Deadline |
| ----- | ------- | -------- |
| Early warning | 14(2)(a) | within 24 hours of becoming aware |
| Vulnerability notification | 14(2)(b) | within 72 hours of becoming aware |
| Final report | 14(2)(c) | no later than 14 days after a corrective or mitigating measure is available |

Pass `--awareness-at <ISO 8601 with a time zone>` (or `--awareness CVE-…=<time>` per advisory) and
the drafts state the 24 hour and 72 hour deadlines in UTC; pass `--corrective-measure-at` as well to
get the final report deadline. Without a time they state the rules and no dates. A time without a
zone is refused. The arithmetic is plain elapsed hours and days on the instants you give; whether any
rule on counting periods applies is for you to confirm. The CISA catalog's "date added" is shown as a
reference, never used as your awareness time.

What the drafts pre-fill from local data: the product (name, version, description from
`package.json`), the advisory (summary, severity, CVSS score, affected packages and fixed versions),
CISA's KEV fields, and the measures the recorded runs and the policy file show. What they mark
**[MANUFACTURER TO COMPLETE]**: the manufacturer's legal name (unless `--manufacturer`), a contact
point, the Member States where the product is made available, what you know of the exploitation and
of any malicious actor, the corrective measures *users* can take, how sensitive you consider the
information, the release that ships the fix, and the awareness time if not given. No contact point,
date or fact the data cannot supply is invented.

What stays manual, by design: the reports are submitted by the manufacturer through the single
reporting platform to the CSIRT designated as coordinator (chosen by the rules of Article 14(7)) and
to ENISA. The drafts follow the *content lists of the Regulation*; they do not reproduce the
platform's own form, which was not checked. Whether an advisory is "actively exploited" in the legal
sense (reliable evidence that a malicious actor exploited it without the system owner's permission,
Article 3(42)) is your judgement: a KEV listing is a pointer to evidence, not the evidence.

### Attestations of recorded runs

For every recorded run whose hash-chained ledger (`steps.jsonl`) verifies, the pack holds a
[DSSE](https://github.com/secure-systems-lab/dsse) envelope (payload type `application/vnd.in-toto+json`)
around an [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md):

- **subject**: the project's manifests, lockfiles, patch files and tsconfig files as they are now, by
  sha256;
- **predicate** (type `https://github.com/Rawlings/autoremediator/attestations/run-ledger/v1`, an
  identifier, not a fetched URL): the run (id, status, plan id, CVE ids, the project fingerprints at
  the start and the end, and whether the project still matches where the run ended), each plan item
  with its outcome (`applied`, `failed`, `rejected`, `not-attempted`) and whether the verifier passed
  it, the findings the plan could not act on, the last full verification's checks, and the ledger: file
  digest, event count and the **head hash** of the chain.

A run whose ledger fails verification is not attested (an attestation of a tampered record would vouch
for nothing); the pack lists it under the run notes.

**Signing.** Attestations are **unsigned by default**: the envelope's `signatures` list is empty and
`manifest.json` says `"signed": false`. Give `--signing-key <pem>` (SDK: `signingKeyPath`), or set
`AUTOREMEDIATOR_EVIDENCE_SIGNING_KEY` to the path of the key file, to sign with a local key:
Ed25519, or ECDSA with P-256 (SHA-256) or P-384 (SHA-384), unencrypted PEM (PKCS#8 or SEC1).
`openssl genpkey -algorithm ed25519 -out evidence-signing.pem` makes one. The signature is over the
DSSE pre-authentication encoding, `"DSSEv1" SP LEN(type) SP type SP LEN(body) SP body`, with lengths
as byte counts in ASCII decimal; ECDSA signatures are DER encoded. Key material is only ever read
from the file; MCP and HTTP callers pass a *path* inside the allowed roots and cannot use the
operator's environment key. The public key is written to `attestations/signing-public-key.pem` for
convenience; it proves nothing, since whoever altered the pack could replace it. Verify against a
key you got from the signer another way.

The pack's own `attestations/pack.intoto.json` has `manifest.json` as its subject, so one signature
covers every file.

**Using cosign.** The envelope is plain DSSE, so tools that read DSSE can verify it with the public key.
To attest to a pack with your existing Sigstore workflow instead, sign the bare statement rather than
the envelope: `cosign attest-blob` accepts `--statement <file>` (a path to an in-toto statement),
`--key` or keyless identity, and `--bundle`, as in `cosign attest-blob --statement
attestations/run-<id>.statement.json --bundle run.sigstore.json <blob>`; check
`cosign attest-blob --help` for your version, because the flags were not run against a cosign binary
for this guide, and cosign's own key format is not a PEM key. Autoremediator has no Sigstore dependency
and does not talk to Fulcio or Rekor.

### Checking a pack

```bash
autoremediator evidence-pack verify compliance/evidence --public-key signer.pub.pem
```

`verify` recomputes the sha256 of every file against `manifest.json`, reports missing and unlisted
files, checks that `pack.intoto.json` attests to this manifest, and, with `--public-key`, verifies
every DSSE signature. It exits 1 on any problem. Without a key it says plainly that signatures were
not checked, or that the pack is unsigned (the digests then show only that the files are unchanged
since the manifest was written). The key inside the pack is never used as a trust anchor.

Verification is not an operation of the MCP or HTTP servers: it is `verifyEvidencePack(dir, { publicKeyPath })`
in the SDK and the CLI command above.

## Options

| CLI | SDK / MCP / HTTP | |
| --- | ---------------- | - |
| `--out <dir>` | `outDir` | Required. Must be absent, empty, or an earlier pack (which is replaced cleanly). Nothing outside it is written. |
| `--cwd` | `cwd` | The project. |
| `--run <id>` (repeatable) | `runIds` | Only these recorded runs. Default: all. |
| `--policy <path>` | `policy` | Policy file for suppressions. |
| `--product-name`, `--product-version` | `productName`, `productVersion` | Default from `package.json`. |
| `--manufacturer <name>` | `manufacturer` | SBOM metadata, OpenVEX author, drafts. |
| `--author <name>` | `author` | OpenVEX author. |
| `--awareness-at <iso>` | `awarenessAt` | Starts the 24h and 72h clocks. |
| `--awareness <cve=iso>` | `awarenessByCve` | Per advisory. |
| `--corrective-measure-at <iso>` | `correctiveMeasureAt` | Starts the 14 day clock. |
| `--signing-key <pem>` | `signingKeyPath` | Sign the attestations. |

SDK: `buildEvidencePack(options)`, `verifyEvidencePack(dir, options)`, `craDeadlines`, `parseAwareness`,
`pae`. MCP tool `buildEvidencePack`; HTTP `POST /evidence-pack` with the options under `options`. Every
path option (`outDir`, `cwd`, `policy`, `signingKeyPath`) is confined to the allowed roots for remote
callers; a key is never accepted inline.

## What it does not do

- It does not decide that anything is compliant, or that an advisory is "actively exploited" in the
  legal sense, or whether your product is in scope of the Regulation.
- It does not submit anything, and does not know the reporting platform's forms.
- It does not fetch KEV or advisory data; only advisories a recorded run already looked up appear.
- It covers dependencies as locked, not your own code's vulnerabilities or the rest of Annex I
  (secure by design, update mechanisms, documentation, and so on).
- It does not attest to anything the ledger does not record; a run that was not recorded
  (`--no-evidence`) leaves no attestation.
- Signing proves a key holder produced these bytes, not that the contents are true.

## Sources

Read for this feature; the field lists and deadlines above follow them. The Official Journal text is
the authority; the readings below came from secondary renderings and should be checked against it.

- Regulation (EU) 2024/2847 (Cyber Resilience Act), Official Journal L, 20.11.2024,
  <https://eur-lex.europa.eu/eli/reg/2024/2847/oj>. Article 14 paragraphs 1 to 8 (24 hour early
  warning, 72 hour notification, final report within 14 days of a corrective measure, the single
  reporting platform and the CSIRT designated as coordinator, informing users), Article 3(42)
  (actively exploited vulnerability), Article 71 (Article 14 applies from 11 September 2026, the rest
  from 11 December 2027), Annex I Part II point 1 (SBOM). Read via
  <https://www.springlex.eu/en/packages/cra/cra-regulation/article-14/>,
  <https://www.springlex.eu/en/packages/cra/cra-regulation/article-3/>,
  <https://www.springlex.eu/en/packages/cra/cra-regulation/article-71/> and
  <https://www.cyberresilienceact.eu/annexes.html>; EUR-Lex itself could not be fetched here.
- CycloneDX 1.6 JSON reference, <https://cyclonedx.org/docs/1.6/json/>, and the 1.6 JSON schema
  (vendored for the tests, see `packages/core/src/features/evidence/pack/fixtures/schemas/README.md`).
- OpenVEX specification v0.2.0, <https://github.com/openvex/spec/blob/main/OPENVEX-SPEC.md>, and its
  JSON schema.
- DSSE protocol, <https://github.com/secure-systems-lab/dsse/blob/master/protocol.md> (the PAE and the
  `DSSEv1 29 http://example.com/HelloWorld 11 hello world` example, which the tests check).
- in-toto Statement v1, <https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md>.
- `cosign attest-blob`, <https://github.com/sigstore/cosign/blob/main/doc/cosign_attest-blob.md>
  (`--statement`, `--predicate`, `--type`, `--key`, `--bundle`).
