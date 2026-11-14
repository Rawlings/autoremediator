---
"autoremediator": minor
---

`autoremediator init`, exit codes an agent can act on, pull requests that update in place, and a Claude Code plugin.

- **`init`** (CLI and SDK): detects the package manager, git host, CI and agent hosts, then writes a
  conservative policy file, a `.gitignore` entry, the MCP server entry for each host (Claude Code,
  Cursor, VS Code, Codex, Gemini CLI), agent skills/rules/a Copilot custom agent, and an `AGENTS.md`
  section. It shows a diff, merges instead of replacing, never overwrites an existing
  `autoremediator` entry, refuses files it cannot parse, and needs `--yes` when there is no terminal
  (exit `3`). `init --check` exits `1` when the setup has drifted. `--ci` also writes a weekly
  GitHub Actions workflow.
- **Claude Code plugin** in `plugins/claude-code` with a marketplace at `.claude-plugin/`: the MCP
  server, three skills (`fix-cve`, `repair-upgrade`, `vet-dependency`), two commands and a subagent,
  generated from the text `init` writes.
- **Exit codes with `--ci`:** `0` fixed or nothing to do, `1` failed, `2` partly fixed, `3` waiting
  for approval, `4` blocked by policy. Previously any failure was `1`; scripts that test for non-zero
  are unaffected. `EXIT_CODES` is exported. Under `--output-format json`, a fatal error is one JSON
  line on stderr.
- **Change requests:** the branch name is now deterministic (`autoremediator/<cve>-<package>`
  instead of ending in a random suffix), so a re-run for the same findings updates the same branch
  and pull request (`updated: true`) instead of opening a duplicate. A re-run replaces only commits
  autoremediator made earlier and only if the branch has not moved (`--force-with-lease`); if a
  person has added commits it refuses and says why. Commit messages carry `Fixes-CVE`,
  `Autoremediator-Run` and `Verified-By` trailers.
