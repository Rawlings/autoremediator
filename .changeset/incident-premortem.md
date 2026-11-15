---
"autoremediator": minor
---

Supply-chain incident mode and compromise pre-mortem.

- **`autoremediator incident <MAL-id | GHSA-id | CVE-id | package@range>`**, SDK `incident`, MCP tool
  and `POST /incident`. Answers locally: whether the package is in the project (direct or transitive,
  versions, parent chain, production or development, install scripts; npm, pnpm, yarn and text bun
  lockfiles), when each affected version entered and left the lockfiles in git history and which
  branches and tags could have installed it (commits and dates only, never a guessed deploy), a
  rollback to the newest version outside the affected range, and a rotation checklist of secret
  **names** in reach of installs (CI workflows, Dockerfiles, env templates, `.npmrc`; values are never
  read, real `.env` files are never opened; a checklist to review, not a finding of compromise).
  `--plan` records the rollback as a plan through the run machinery, held for approval and never
  applied; `--output-dir` writes `incident-report.md` and `incident-report.json`. Works offline for
  `package@range`; ids honour `--offline --intelligence-snapshot`. Exits `0` clear, `3` in history
  only, `4` locked now.
- **`autoremediator premortem --targets-file <json> | --root <dir>`**, SDK `premortem`, MCP tool and
  `POST /premortem`. For named packages, or the most depended-upon or most privileged ones, reports
  which repositories lock them, versions, install scripts and whether CI installs run with secrets in
  reach, and with `--output-dir` writes a playbook per repository or package with the exact commands
  for the day. No network.
- Plan items that go back to an older version carry `rollback: true` (shown by `runs show`), and
  `version-bump` pins a downgrade exactly instead of keeping the caret, so the install actually moves
  off the bad version.
- `AffectedPackage.source` gains `user-supplied`.
- New page `docs/guides/incident-response.md`.
