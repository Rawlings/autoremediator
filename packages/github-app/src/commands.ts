/**
 * Comment commands: `/autoremediator <command> [ids]` on an issue or pull request.
 * Comment text is untrusted input, so nothing from it is used except the command word and
 * advisory ids that match a strict pattern.
 *
 * There is deliberately no `approve`: nothing in the app can safely stand in for a reviewer's
 * approval, so the word is unrecognised and answered with help like any other unknown word.
 */
export const COMMAND_NAMES = ["help", "plan", "fix", "retry", "rollback"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export interface ParsedCommand {
  name: CommandName;
  /** Advisory ids given on the command line, upper-cased and de-duplicated. */
  advisoryIds: string[];
  /** Words that were not recognised (reported back, never acted on). */
  ignored: string[];
}

const ADVISORY_ID = /^(CVE-\d{4}-\d{4,7}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/i;
const MAX_IDS = 10;
const PREFIX = "/autoremediator";

/** Drop trailing commas and semicolons with a scan, not a `[,;]+$` pattern (quadratic on long runs). */
function stripTrailingSeparators(word: string): string {
  let end = word.length;
  while (end > 0 && (word[end - 1] === "," || word[end - 1] === ";")) end -= 1;
  return word.slice(0, end);
}

/**
 * Find the first command in a comment. Quoted lines (`>`) and fenced code are skipped, so quoting
 * someone's command in a reply, or showing it in an example, does not run it.
 */
export function parseComment(body: string): ParsedCommand | undefined {
  let inFence = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Not a regex over the whole line: `\s+(.*)` backtracks on long runs of spaces.
    if (!line.toLowerCase().startsWith(PREFIX)) continue;
    const afterPrefix = line.slice(PREFIX.length);
    if (afterPrefix !== "" && !/^\s/.test(afterPrefix)) continue;

    const words = afterPrefix.split(/\s+/).filter(Boolean);
    const first = words[0]?.toLowerCase();
    const name = COMMAND_NAMES.find((candidate) => candidate === first) ?? "help";
    const rest = first && name === first ? words.slice(1) : words;

    const ids = new Set<string>();
    const ignored: string[] = [];
    for (const word of rest) {
      const cleaned = stripTrailingSeparators(word);
      if (ADVISORY_ID.test(cleaned) && ids.size < MAX_IDS) ids.add(cleaned.toUpperCase());
      else ignored.push(cleaned.slice(0, 40));
    }
    return { name, advisoryIds: [...ids], ignored: ignored.slice(0, 5) };
  }
  return undefined;
}

export const HELP_TEXT = [
  "**Autoremediator commands** (write access required):",
  "",
  "- `/autoremediator plan CVE-2021-23337` shows what would change. Nothing is modified.",
  "- `/autoremediator fix CVE-2021-23337` fixes it and opens a pull request for review.",
  "- `/autoremediator retry CVE-2021-23337` runs it again the way it was last run here (plan or fix).",
  "- `/autoremediator rollback` replies with the command that undoes the run this pull request records. The app never rolls back by itself.",
  "- `/autoremediator help` shows this message.",
  "",
  "Give one or more CVE or GHSA ids, separated by spaces (`plan`, `fix` and `retry`).",
].join("\n");
