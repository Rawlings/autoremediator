# Security Policy

## Supported Versions

The latest published version of `autoremediator` receives security fixes.
Older versions are not actively patched.

| Version | Supported |
|---------|-----------|
| Latest  | ✅        |
| Older   | ❌        |

## Reporting a Vulnerability

Please **do not** file public GitHub issues for security vulnerabilities.

Report vulnerabilities privately using [GitHub's security advisory feature](https://github.com/Rawlings/autoremediator/security/advisories/new).

We will acknowledge the report within 5 business days and aim to publish a fix within 30 days of confirmation.

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

These calls use read-only public APIs, carry no credentials, and are expected behavior.
They can be monitored or blocked via network policy in controlled environments.
