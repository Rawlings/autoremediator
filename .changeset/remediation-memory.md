---
"autoremediator": minor
---

Remediation memory: a committed, human-editable file, `.autoremediator/memory.md`, that keeps what a
repository has learned between runs (how its tests run, flaky tests, pinned packages, rejected
upgrades, install quirks) and puts it to work.

- **Planner**: a `pinned-package` entry leaves the package alone (`constraint-blocked`, naming the
  entry and its reason; `updateOutdated` skips it too), and a `rejected-upgrade` entry is never proposed
  again (the next fixed version is chosen, or the result is `constraint-blocked`). `--ignore-memory` /
  `ignoreMemory` plans as if memory were empty; it is SDK and CLI only, so an agent cannot lift a
  person's constraint. A `test-command` entry is used only where the project has no `test` script.
- **Agents**: the built-in repair agent reads the relevant entries as quoted data in its prompt and has a
  `proposeMemory` tool; a proposal is stored as `proposed` and does nothing until `memory accept`. Host
  agents get the entries in `startAttempt` (`memory`) and the MCP resource `autoremediator://memory`.
- **Evidence only**: `runs apply` and `finalizeAttempt` record an upgrade the verifier rejected as
  `rejected-upgrade` (run id and failing check, 90 days) and a passing test command as `test-command`.
- **Commands**: `autoremediator memory list|add|accept|remove|prune`; SDK `listMemory`, `addMemory`,
  `acceptMemory`, `removeMemory`, `pruneMemory`, `proposeMemory`; MCP tool and `POST /memory/list`
  for `listMemory` (read only; the writers are CLI and SDK only).
- **File**: Markdown with one fenced `autoremediator-memory` block of one-JSON-object-per-line entries.
  Prose outside the block, and every line you did not change, is preserved byte for byte. Entries are
  single-line, length-capped, stripped of control and bidirectional characters, capped at 200 entries
  and 64 KiB, and may expire.
- A rollback does not rewind the file and the scope check does not count it as a change.

See `docs/guides/memory.md`.
