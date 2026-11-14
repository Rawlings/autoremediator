---
"autoremediator": minor
---

Safer upgrade-version selection and less redundant intelligence traffic:

- Fixed versions are ranked best first (smallest upgrade, then lowest version). Prereleases are
  skipped unless the project or the advisory fix is itself a prerelease, and deprecated releases are
  tried last.
- If the best candidate fails the supply-chain gate or has known advisories of its own, the next
  candidates are tried (up to five) instead of giving up. Passed-over versions are listed in the
  result message. The advisory check is skipped with `--offline`, and a failed lookup never blocks.
- The package manager's own release cooldown is enforced: npm `min-release-age`, pnpm
  `minimumReleaseAge` (including the pnpm 11 default), yarn `npmMinimalAgeGate`, and bun
  `minimumReleaseAge`, merged with `supplyChainPolicy.minPublishAgeHours`. Previously a freshly
  published fix would be chosen and then fail to install.
- The CISA KEV feed is downloaded once per process and shared (it was fetched again for every CVE).
- The patch generator uses `generateText` with structured output instead of the deprecated
  `generateObject`.
