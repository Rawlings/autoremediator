# Security Policy

## Supported Versions

The latest published version of `autoremediator` receives security fixes.
Older versions are not actively patched.

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |
| Older   | No        |

## Reporting a Vulnerability

Do not file public GitHub issues for security vulnerabilities.

Report vulnerabilities privately using [GitHub's security advisory feature](https://github.com/Rawlings/autoremediator/security/advisories/new).

Reports are acknowledged within 5 business days, with confirmed issues targeted for resolution within 30 days.

## Expected Outbound Network Connections

`autoremediator` makes outbound HTTPS requests to public security intelligence APIs as part of its core function:

- `api.osv.dev` — OSV vulnerability records
- `api.github.com` — GitHub Advisory Database
- `services.nvd.nist.gov` — NVD CVSS context
- `www.cisa.gov` — CISA Known Exploited Vulnerabilities
- `api.first.org` — FIRST EPSS exploit probability scores
- `cveawg.mitre.org` — CVE Services references
- `advisories.gitlab.com` — GitLab Advisory Database
- `www.kb.cert.org` — CERT/CC vulnerability notes
- `api.deps.dev` — deps.dev package metadata
- `api.securityscorecards.dev` — OpenSSF Scorecard repository posture
- `registry.npmjs.org` — npm package registry

These requests query read-only public endpoints and transmit no credentials or repository code. They can be monitored or redirected in air-gapped environments using local intelligence snapshots.
