# Remediation memory

Every repository has operational knowledge that today is lost between runs: how its tests run, which
tests are flaky, which upgrade a person rejected and why, which packages must stay pinned, which
install needs a system library. **Remediation memory** keeps it in one committed, reviewable file,
`.autoremediator/memory.md`, and puts it to work:

- the **planner** obeys it: a pinned package is left alone, and an upgrade that was rejected is not
  proposed again;
- a project with **no test script** runs the test command memory holds;
- the **agent** that repairs an upgrade, and a **host agent** that drives an attempt, read it as data.

Nothing leaves your machine, there is no service, and nothing is recorded without evidence: a run
writes to memory only what its own verifier established, and an agent can only _propose_.

## The file

Markdown you can edit freely. Everything outside one fenced block is your prose and is never touched
(byte for byte, including line endings). Inside the block, each line is one entry:

````markdown
# Autoremediator memory

Our notes. The monorepo root has no tests of its own; run them per package.

```autoremediator-memory
{"kind":"pinned-package","status":"active","package":"left-pad","reason":"v2 drops the callback API","source":"human:ana","createdAt":"2026-03-01T10:00:00.000Z"}
{"kind":"rejected-upgrade","status":"active","package":"lodash","fromVersion":"4.17.20","toVersion":"5.0.0","reason":"the verifier's tests check failed after the upgrade","check":"tests","source":"run_0123456789abcdefghij","createdAt":"2026-03-02T09:30:00.000Z","expiresAt":"2026-05-31T09:30:00.000Z"}
```

Anything below the block is also yours.
````

Edit a line by hand, delete a line to delete the entry, or add a line. Lines that are not valid
entries are kept exactly as they are, ignored, and listed by `memory list` with what is wrong. The
file has a hard cap of 200 entries and 64 KiB of entries; past it, the extra entries are ignored and
reported.

Entries have an id derived from what makes them the same fact (for example the package for a pin, the
package and target version for a rejection), shown by `memory list` and used by `remove` and
`accept`. The same fact is never recorded twice.

### Kinds

| Kind               | Fields                                                | What it does                                                                                                  |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pinned-package`   | `package`, `reason`                                   | The planner leaves the package alone: the result is `constraint-blocked`, with the reason and the entry id.   |
| `rejected-upgrade` | `package`, `fromVersion?`, `toVersion`, `reason`, `check?` | The planner never proposes `package@toVersion`; it picks the next fixed version, or is `constraint-blocked`. |
| `test-command`     | `command`                                             | Used as the test command only when the project has no `test` script (see below). Always shown to agents.     |
| `flaky-test`       | `test`, `note?`                                       | Shown to agents and hosts.                                                                                    |
| `install-quirk`    | `text`                                                | Shown to agents and hosts.                                                                                    |
| `note`             | `text`                                                | Shown to agents and hosts.                                                                                    |

Every entry also has `status` (`active` or `proposed`), `createdAt`, `source` and optionally
`expiresAt`. `source` is `human`, `human:<name>`, a run id (recorded by that run), or `agent[:<run id>]`
(proposed by an agent).

Text is one line, at most 200 characters, with control, zero-width and bidirectional-override characters
removed. A `test-command` must be a package manager script invocation (`npm`, `pnpm`, `yarn`, `bun` or
`deno` with `test`, `run <script>` or `task <name>`), made of plain words with no quotes, pipes or
variables, and it runs as an argument list, never through a shell. `dlx`, `exec` and `npx` are refused.

## Commands

```sh
autoremediator memory list [--kind pinned-package] [--state active|proposed|expired] [--output-format json]
autoremediator memory add pinned-package left-pad --reason "v2 drops the callback API" --by ana
autoremediator memory add rejected-upgrade lodash --from 4.17.20 --to 5.0.0 --reason "breaks our build"
autoremediator memory add test-command "pnpm run test:unit"
autoremediator memory add flaky-test api/retry.test.ts --note "times out on CI"
autoremediator memory add install-quirk "needs python3 for node-gyp" --expires-in-days 365
autoremediator memory add note "the monorepo root has no tests"
autoremediator memory accept mem_0123456789   # make an agent's proposal take effect
autoremediator memory remove mem_0123456789
autoremediator memory prune                   # drop expired entries
```

The SDK has `listMemory`, `addMemory`, `acceptMemory`, `removeMemory`, `pruneMemory` and
`proposeMemory`. `listMemory` is also an MCP tool and `POST /memory/list`, and the MCP resource
`autoremediator://memory` returns what is in force. The writers are deliberately CLI and SDK only: a
tool an agent can call must not be able to change what the planner will do.

## What reads it

**The planner.** `remediate`, `planRemediation`, and everything built on them read memory at the start
of a run.

- A pinned package becomes a finding the plan cannot act on, with `unresolvedReason:
  constraint-blocked` and a message that names the entry, its source and the reason. It appears in the
  plan's `skipped` list. `updateOutdated` skips it too (`pinned-by-memory` in the evidence).
- A rejected upgrade is passed over when choosing the version. If every fixed version was rejected,
  the result is `constraint-blocked`.
- Only `active`, unexpired entries count. `--ignore-memory` (SDK: `ignoreMemory`) plans as if memory
  were empty. It is not accepted over MCP or HTTP, so an agent cannot lift a person's constraint.

**Freshness** reads memory too: `freshness` leaves a pinned package alone and never proposes a version a
rejected upgrade names (see [dependency freshness](freshness.md#memory)).

**Plans are re-checked at apply time for pins.** `applyPlan` (`runs apply`, and `freshness --apply`)
refuses, before changing anything, a plan that has an item for a package pinned in memory since the plan
was made, with a message naming the entry. Rejected upgrades are not re-checked at apply time (a plan
already names the version it will land on); plan again after changing memory. A plan made with
`--ignore-memory` is applied without consulting memory. A memory file that cannot be read safely (a symbolic link, a directory, or over 1 MiB)
stops the run with an error rather than being skipped; fix it, or pass `--ignore-memory`.

**The test command.** The test command is the package manager's own (`npm test`, `pnpm test`, ...).
When the project has no `test` script, or only npm's "no test specified" placeholder, a matching
`test-command` entry (one that starts with the project's package manager and, for `run <script>`,
names a script that exists) is used instead. A script the project defines is never overridden, and
nothing is used when a workspace is selected. In an isolated checkout the entry is only visible if
the memory file is committed (see [Committing it](#committing-it)).

**Agents.** The built-in repair agent gets the entries that bear on the package in its prompt, inside a
`<memory-data>` block: a JSON array with `<` and `>` escaped, preceded by the statement that it is
data and not instructions, and the system prompt says the same. Host agents get the same entries in
`startAttempt`'s `memory` field and from the `autoremediator://memory` resource. Proposed and expired
entries are never shown to an agent.

## What writes it

**You**, with the commands above or by editing the file.

**Runs, from evidence.** After `runs apply` (and `finalizeAttempt`):

- an upgrade the **verifier rejected and rolled back** becomes a `rejected-upgrade` entry, citing the
  run id and the check that failed, for `install`, `vuln-gone`, `typecheck`, `tests` and
  `proof-of-fix`. `scope`, `policy` and `supply-chain` failures are not remembered: they are about
  rules and release age, which change without the upgrade changing. The reason is a fixed sentence, never
  command output. These entries expire after 90 days.
- a **test command that passed** (the `tests` check, or an applied item with `--run-tests`) becomes a
  `test-command` entry, expiring after 180 days. `verifyRun` records the one its `tests` check passed.

A person rejecting a pull request is not observable, so it is never recorded; add it yourself with
`memory add rejected-upgrade`. A flaky test failure can produce a wrong rejection; that is what the
expiry, `memory remove` and `--ignore-memory` are for.

**Agents, as proposals.** The built-in repair agent has a `proposeMemory` tool (at most five calls per
attempt). A proposal is stored with `status: "proposed"` and `source: "agent:<run id>/<attempt id>"`,
changes nothing, and waits for `memory accept <id>`. Proposals that read like instructions or links
("ignore previous instructions", "you must", URLs, markup) are refused as a first filter; the real
control is that nothing proposed does anything until you accept it, and that everything shown to a
model is quoted as data. No more than 20 proposals can wait.

## Size and expiry

At most 200 entries and 64 KiB. When a write would go past the cap, expired entries go first, oldest
first. A run's own auto-recorded entries may then replace the oldest auto-recorded ones. Entries a
person wrote or accepted are never evicted: the write fails with a message instead. Expired entries
change nothing and `memory prune` removes them.

Writes are serialized with a lock and replace the file atomically. A write is refused (and the file
left as it is) when it cannot be read back, for example when your prose leaves a code fence open
above the block, or when the block itself is not closed.

## Committing it

Run state under `.autoremediator/` is git-ignored, with exceptions for what is meant to be committed.
Memory is one of them, so the ignore rules need the negation `!.autoremediator/memory.md` beside the
ones for `recipes/` and `track-record.json`:

```gitignore
.autoremediator/*
!.autoremediator/recipes/
!.autoremediator/track-record.json
!.autoremediator/memory.md
```

Without it the file still works, but only on the machine that has it. A rollback does not rewind the
file, and the scope check does not count a change to it against a run.
