/** `autoremediator memory list | add | remove | accept | prune`. See docs/guides/memory.md. */
import type { Command } from "commander";

import {
  acceptMemory,
  addMemory,
  listMemory,
  type MemoryEntry,
  type MemoryKind,
  type NewMemoryEntry,
  OPTION_DESCRIPTIONS,
  pruneMemory,
  removeMemory,
} from "../../../api/index.js";
import { MEMORY_KINDS, unreachable } from "../../../features/memory/entries.js";
import { logJson } from "../output.js";
import { validateOutputFormat } from "../validators.js";

interface MemoryCliOptions {
  cwd: string;
  outputFormat: "text" | "json";
  kind?: string;
  state?: string;
  note?: string;
  reason?: string;
  from?: string;
  to?: string;
  by?: string;
  expiresInDays?: number;
}

const out = (text: string) => process.stdout.write(`${text}\n`);

const common = (command: Command): Command =>
  command
    .option("--cwd <path>", OPTION_DESCRIPTIONS.cwd, process.cwd())
    .option("--output-format <format>", "Output format: text|json", "text");

/** What an entry says, on one line. */
export function describeEntry(entry: MemoryEntry): string {
  switch (entry.kind) {
    case "test-command": {
      return entry.command;
    }
    case "flaky-test": {
      return entry.note ? `${entry.test} (${entry.note})` : entry.test;
    }
    case "pinned-package": {
      return `${entry.package}: ${entry.reason}`;
    }
    case "rejected-upgrade": {
      return `${entry.package} ${entry.fromVersion ? `${entry.fromVersion} -> ` : "-> "}${entry.toVersion}: ${entry.reason}`;
    }
    case "install-quirk":
    case "note": {
      return entry.text;
    }
    default: {
      return unreachable(entry);
    }
  }
}

const day = (iso: string): string => iso.slice(0, 10);

function parseKind(value: string | undefined): MemoryKind | undefined {
  if (value === undefined) return undefined;
  if (!(MEMORY_KINDS as readonly string[]).includes(value)) {
    throw new Error(`Unknown kind "${value}". Use one of: ${MEMORY_KINDS.join(", ")}.`);
  }
  return value as MemoryKind;
}

/** The entry `memory add <kind> <value>` describes. */
export function entryFromArguments(
  kind: MemoryKind,
  value: string,
  opts: MemoryCliOptions,
): NewMemoryEntry {
  const needs = (flag: string, given: string | undefined): string => {
    if (!given) throw new Error(`${kind} needs ${flag}.`);
    return given;
  };
  const source = opts.by ? `human:${opts.by}` : undefined;
  const expires = opts.expiresInDays === undefined ? {} : { expiresInDays: opts.expiresInDays };
  const envelope = { ...(source ? { source } : {}), ...expires };
  switch (kind) {
    case "test-command": {
      return { kind, command: value, ...envelope };
    }
    case "flaky-test": {
      return { kind, test: value, ...(opts.note ? { note: opts.note } : {}), ...envelope };
    }
    case "pinned-package": {
      return { kind, package: value, reason: needs("--reason", opts.reason), ...envelope };
    }
    case "rejected-upgrade": {
      return {
        kind,
        package: value,
        toVersion: needs("--to <version>", opts.to),
        reason: needs("--reason", opts.reason),
        ...(opts.from ? { fromVersion: opts.from } : {}),
        ...envelope,
      };
    }
    case "install-quirk":
    case "note": {
      return { kind, text: value, ...envelope };
    }
    default: {
      return unreachable(kind);
    }
  }
}

/** Register `memory`. */
export function registerMemoryCommands(program: Command): void {
  const memory = program
    .command("memory")
    .description(
      "Remediation memory (.autoremediator/memory.md): what this repository has learned between runs, as short validated entries a person can review and edit",
    );

  common(
    memory
      .command("list")
      .description("List what the repository remembers, what is in force and what is only proposed")
      .option("--kind <kind>", `Only this kind: ${MEMORY_KINDS.join("|")}`)
      .option("--state <state>", "Only entries that are active, proposed or expired"),
  ).action((opts: MemoryCliOptions) => {
    validateOutputFormat(opts.outputFormat, ["text", "json"], "memory list");
    const kind = parseKind(opts.kind);
    if (opts.state && !["active", "proposed", "expired"].includes(opts.state)) {
      throw new Error(`--state must be active, proposed or expired, not "${opts.state}".`);
    }
    const listing = listMemory({
      cwd: opts.cwd,
      ...(kind ? { kind } : {}),
      ...(opts.state ? { state: opts.state as "active" | "proposed" | "expired" } : {}),
    });
    if (opts.outputFormat === "json") {
      logJson(listing);
      return;
    }
    out(
      `${listing.path}: ${listing.counts.active} active, ${listing.counts.proposed} proposed, ${listing.counts.expired} expired (room for ${listing.limits.maxEntries - listing.counts.total} more)`,
    );
    if (!listing.exists) out("No memory file yet. `autoremediator memory add` creates it.");
    for (const entry of listing.entries) {
      const expiry = entry.expiresAt ? `, expires ${day(entry.expiresAt)}` : "";
      out(
        `  ${entry.id}  ${entry.state.padEnd(8)} ${entry.kind.padEnd(16)} ${describeEntry(entry)}  [${entry.source}, ${day(entry.createdAt)}${expiry}]`,
      );
    }
    if (listing.counts.proposed > 0) {
      out("Proposed entries do nothing until accepted: `autoremediator memory accept <id>`.");
    }
    for (const problem of listing.problems) out(`  problem: ${problem}`);
  });

  common(
    memory
      .command("add <kind> <value>")
      .description(
        `Record a fact. kind: ${MEMORY_KINDS.join(", ")}. value is the command, test, package name or text`,
      )
      .option("--reason <text>", "pinned-package and rejected-upgrade: why")
      .option("--note <text>", "flaky-test: an optional note")
      .option("--from <version>", "rejected-upgrade: the version the project was on")
      .option(
        "--to <version>",
        "rejected-upgrade: the rejected version, which the planner will not propose again",
      )
      .option("--by <name>", "Who is recording this (default: human)")
      .option("--expires-in-days <n>", "Stop counting this entry after n days", (value: string) =>
        Number.parseInt(value, 10),
      ),
  ).action(async (kindArg: string, value: string, opts: MemoryCliOptions) => {
    validateOutputFormat(opts.outputFormat, ["text", "json"], "memory add");
    const kind = parseKind(kindArg)!;
    const report = await addMemory({ cwd: opts.cwd, ...entryFromArguments(kind, value, opts) });
    if (opts.outputFormat === "json") {
      logJson(report);
      return;
    }
    out(
      report.created
        ? `Recorded ${report.entry.id}: ${describeEntry(report.entry)}`
        : `Already recorded as ${report.entry.id}; remove it first to change it.`,
    );
    for (const id of report.evicted) out(`Made room by dropping ${id}.`);
  });

  common(memory.command("remove <id>").description("Delete an entry")).action(
    async (id: string, opts: MemoryCliOptions) => {
      validateOutputFormat(opts.outputFormat, ["text", "json"], "memory remove");
      const { removed } = await removeMemory({ cwd: opts.cwd, id });
      if (opts.outputFormat === "json") logJson({ removed });
      else out(`Removed ${removed.id}: ${describeEntry(removed)}`);
    },
  );

  common(
    memory
      .command("accept <id>")
      .description("Accept an entry an agent proposed, so it takes effect"),
  ).action(async (id: string, opts: MemoryCliOptions) => {
    validateOutputFormat(opts.outputFormat, ["text", "json"], "memory accept");
    const { accepted, alreadyActive } = await acceptMemory({ cwd: opts.cwd, id });
    if (opts.outputFormat === "json") logJson({ accepted, alreadyActive });
    else
      out(
        alreadyActive
          ? `${accepted.id} was already in force.`
          : `Accepted ${accepted.id}: ${describeEntry(accepted)}`,
      );
  });

  common(memory.command("prune").description("Remove expired entries")).action(
    async (opts: MemoryCliOptions) => {
      validateOutputFormat(opts.outputFormat, ["text", "json"], "memory prune");
      const { removed } = await pruneMemory({ cwd: opts.cwd });
      if (opts.outputFormat === "json") logJson({ removed });
      else if (removed.length === 0) out("Nothing has expired.");
      else for (const entry of removed) out(`Removed ${entry.id}: ${describeEntry(entry)}`);
    },
  );
}
