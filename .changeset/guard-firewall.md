---
"autoremediator": minor
---

`guard`: check a package before an agent installs it, and fix a supply-chain gate that never fired.

- **`autoremediator guard <package...>`**, SDK `guardPackage`/`guardPackages`, MCP tool `guardPackage`
  and `POST /packages/guard`. It judges a package before install and answers `allow`, `warn` or
  `block` with findings and a safer alternative: does it exist (assistants invent names), is it in the
  OSV malware feed, does its name imitate a popular package, is the release inside the cooldown (72
  hours by default), did it gain install scripts or lose build provenance, does it have known
  vulnerabilities. A failed lookup is a warning, never a silent pass. Exit `0` clear, `3` check first,
  `4` blocked.
- **Claude Code hook.** `autoremediator guard-hook` is a `PreToolUse` hook for Bash that checks the
  packages in `npm`/`pnpm`/`yarn`/`bun` install commands and denies or asks. Install it with
  `autoremediator init --guard` (merges into `.claude/settings.json`) or through the Claude Code
  plugin, which now includes it. It is a guard rail for plain install commands, not a security
  boundary.
- **Fix:** the supply-chain trust check (`minPublishAgeHours`, `blockInstallScripts`) asked the npm
  registry for the abbreviated package document, which has no publish times and no scripts, so both
  gates silently passed against registry.npmjs.org. It now requests the full document.
