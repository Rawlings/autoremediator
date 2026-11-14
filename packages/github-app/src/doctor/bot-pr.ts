/**
 * Which pull requests the bot PR doctor may look at. Everything here works on names and logins
 * that GitHub sends, and decides only whether a pull request is *eligible*; nothing in it is
 * trusted to make a change safe.
 */
export type BotKind = "dependabot" | "renovate";

const BOT_BRANCH_PREFIXES: ReadonlyArray<readonly [string, BotKind]> = [
  ["dependabot/", "dependabot"],
  ["renovate/", "renovate"],
];

const BOT_LOGINS: Readonly<Record<string, BotKind>> = {
  "dependabot[bot]": "dependabot",
  "renovate[bot]": "renovate",
};

/** The bot a branch name belongs to, going by its prefix alone. */
export function botKindOfBranch(headRef: string): BotKind | undefined {
  return BOT_BRANCH_PREFIXES.find(([prefix]) => headRef.startsWith(prefix))?.[1];
}

/** The bot a pull request author login belongs to. */
export function botKindOfLogin(login: string | undefined): BotKind | undefined {
  return login === undefined ? undefined : BOT_LOGINS[login.toLowerCase()];
}

/** A pull request is a bot's if its branch or its author says so. */
export function detectBotPr(headRef: string, authorLogin?: string): BotKind | undefined {
  return botKindOfBranch(headRef) ?? botKindOfLogin(authorLogin);
}

interface RepoLike {
  id?: unknown;
  full_name?: unknown;
}

/**
 * True when the pull request's head lives in another repository (or no longer exists, as when a
 * fork was deleted). The app never writes to a fork's branch.
 */
export function isForkPullRequest(pr: {
  head?: { repo?: RepoLike | null } | null;
  base?: { repo?: RepoLike | null } | null;
}): boolean {
  const head = pr.head?.repo;
  const base = pr.base?.repo;
  if (!head || !base) return true;
  if (typeof head.id === "number" && typeof base.id === "number") return head.id !== base.id;
  if (typeof head.full_name === "string" && typeof base.full_name === "string") {
    return head.full_name.toLowerCase() !== base.full_name.toLowerCase();
  }
  return true;
}
