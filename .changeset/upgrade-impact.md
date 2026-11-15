---
"autoremediator": minor
---

Upgrade impact and fix-diff vulnerable symbols.

- **`assessUpgrade`** (CLI `autoremediator assess <pkg> --from A --to B`, MCP tool, `POST /packages/assess-upgrade`, SDK): downloads both
  versions, compares their public API (declaration files, else JavaScript exports), `engines.node`,
  module format, `exports` map and peer dependencies, intersects the changes with the project's own
  usage, and returns a High, Medium or Low breakability rating with the affected `file:line` call
  sites and reasons. The rating is a fixed points table, not a model.
- **`findVulnerableSymbols`** (CLI `autoremediator symbols <pkg> --from A --to B`, MCP tool,
  `POST /packages/vulnerable-symbols`, SDK): lists the exports whose implementation changed between a
  vulnerable version and its fix (formatting and comments ignored), ranked and optionally steered by
  advisory text and CWE ids, each checked for reachability from the project. A heuristic: a changed
  export is a candidate, not proof.
- Tarballs are read in memory under size and entry limits; path traversal, corrupt headers and decompression bombs are
  refused and links are never followed.
- New page `docs/guides/upgrade-impact.md`.
