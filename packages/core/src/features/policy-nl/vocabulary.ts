import { UNRESOLVED_REASON_VALUES } from "../../infra/policy/schemas.js";
import { tokensOf } from "./request-match.js";

/**
 * What the words of a request must contain to be about a policy key. This is the lock behind two
 * checks in `compile.ts`: a phrase the model quotes may only explain keys it is about, and a loosening
 * needs words in the request that ask for exactly that. It is a keyword check on whole words, not an
 * understanding of intent: it makes a model's mistakes (or a talked-into answer) fail, it does not
 * make the request's meaning certain, which is why the person still reviews the diff.
 */

interface Entry {
  /** Words that make a phrase about the key at all. */
  related: RegExp;
  /** Words that make a phrase ask for the key to be loosened; defaults to `related`. */
  loosen?: RegExp;
}

const words = (source: string): RegExp => new RegExp(source, "u");
/** `\bstem\w*` for each stem, as one alternation. */
const stems = (...list: string[]): string => list.map((stem) => `\\b${stem}\\w*`).join("|");

const EXPLOIT = stems("exploit");
const SEVERITY = String.raw`\bcritical\b|\bhigh\b|\bmedium\b|\blow\b|\bseverit(?:y|ies)\b`;
const REASONS = UNRESOLVED_REASON_VALUES.map(
  (reason) => `\\b${reason.replaceAll("-", "[- ]")}\\b`,
).join("|");

/** One entry per key a model may touch (and the sub-keys that have their own words). */
const TABLE: Readonly<Record<string, Entry>> = {
  allowMajorBumps: { related: words(String.raw`\bmajors?\b|\bbreaking\b|\bsemver\b`) },
  denyPackages: {
    related: words(
      `\\bden(?:y|ies|ied|ylist)\\b|${stems("block", "unblock", "exclud", "touch", "chang", "modif", "upgrad", "updat", "bump", "allow", "permit", "remov", "lift", "clear", "packag", "dependenc")}|\\bban(?:s|ned)?\\b|\\bunban(?:s|ned)?\\b|\\bdrop(?:s|ped)?\\b|\\bpin(?:s|ned)?\\b|\\bleave\\b|\\balone\\b|\\breset\\b|\\bnever\\b`,
    ),
    loosen: words(
      `${stems("allow", "permit", "unblock", "remov", "lift", "clear", "touch", "exclud", "upgrad", "updat", "enabl")}|\\bunban(?:s|ned)?\\b|\\bdrop(?:s|ped)?\\b|\\breset\\b|\\bno longer\\b|\\bstop(?:s|ped)? (?:blocking|denying|banning|excluding)\\b|\\bmay\\b|\\bcan\\b|\\bfree\\b|\\bbump\\b`,
    ),
  },
  allowPackages: {
    related: words(
      `${stems("allow", "permit", "whitelist", "includ", "restrict", "limit", "packag", "touch", "chang", "modif", "updat", "upgrad", "remov", "lift", "clear", "widen", "extend")}|\\bonly\\b|\\badd\\b|\\balso\\b|\\bdrop(?:s|ped)?\\b`,
    ),
    loosen: words(
      `${stems("allow", "permit", "whitelist", "includ", "touch", "remov", "lift", "clear", "widen", "extend")}|\\badd\\b|\\balso\\b|\\bdrop(?:s|ped)?\\b`,
    ),
  },
  constraints: { related: words(String.raw`\bconstraints?\b`) },
  "constraints.directDependenciesOnly": {
    related: words(
      String.raw`\bdirect\b|\btransitive\b|\bindirect\b|\bdependenc(?:y|ies)\b|\btop-level\b|\bnested\b`,
    ),
  },
  "constraints.preferVersionBump": {
    related: words(
      `${stems("bump", "overrid", "prefer", "upgrad")}|\\bversion bumps?\\b|\\bpatch(?:es|ing)?\\b`,
    ),
  },
  "constraints.installMode": {
    related: words(`${stems("install", "cache")}|\\boffline\\b|\\bdeterministic\\b`),
  },
  "constraints.installPreferOffline": {
    related: words(`${stems("install", "cache")}|\\boffline\\b`),
  },
  "constraints.enforceFrozenLockfile": {
    related: words(String.raw`\bfrozen\b|\block[- ]?files?\b`),
  },
  "constraints.workspace": { related: words(String.raw`\bworkspaces?\b|\bmonorepo\b`) },
  "constraints.typecheck": {
    related: words(String.raw`\btype-?check\w*|\btypes?\b|\btsc\b|\btypescript\b`),
  },
  "constraints.requireProofOfFix": {
    related: words(`${stems("proof", "prove", "verif", "reproduc")}|\\bregression\\b`),
  },
  "constraints.enableBreakingChangeRefactor": {
    related: words(`${stems("refactor", "rewrit")}|\\bcodemods?\\b|\\bbreaking\\b`),
  },
  "constraints.supplyChainPolicy": { related: words(String.raw`\bsupply[- ]chain\b`) },
  "constraints.supplyChainPolicy.minPublishAgeHours": {
    related: words(
      `${stems("publish", "fresh", "wait")}|\\bage\\b|\\baged\\b|\\bhours?\\b|\\bdays?\\b|\\bnewly\\b|\\bnew (?:versions?|releases?)\\b|\\bcool-?off\\b|\\bolder\\b|\\bat least\\b`,
    ),
  },
  "constraints.supplyChainPolicy.blockInstallScripts": {
    related: words(
      String.raw`\binstall[- ]?scripts?\b|\blifecycle\b|\bpostinstall\b|\bpreinstall\b|\bscripts?\b`,
    ),
  },
  "constraints.supplyChainPolicy.requireProvenance": {
    related: words(String.raw`\bprovenance\b|\battestations?\b|\bsigned\b|\bsigstore\b`),
  },
  exploitSignalOverride: { related: words(`${EXPLOIT}|\\bsignals?\\b`) },
  "exploitSignalOverride.kev": {
    related: words(String.raw`\bkev\b|\bknown[- ]exploited\b|\bcisa\b|\bexploited\b`),
  },
  "exploitSignalOverride.epss": {
    related: words(`\\bepss\\b|${EXPLOIT}|\\blikelihood\\b|\\bprobab\\w*`),
  },
  suppressions: {
    related: words(
      `${stems("suppress", "ignor", "dismiss", "silenc", "mitigat", "waiv", "exempt", "snooze", "defer")}|\\bnot affected\\b|\\bfalse positives?\\b|\\bexceptions?\\b|\\bvex\\b|\\baccept(?:ed)? (?:the )?risk\\b|\\bcve-\\d{4}-\\d{4,}\\b|\\bghsa(?:-[a-z0-9]{4}){3}\\b`,
    ),
  },
  // A deadline needs a time or the word for one; a severity alone does not say how long.
  sla: {
    related: words(
      String.raw`\bsla\b|\bdeadlines?\b|\bhours?\b|\bdays?\b|\bweeks?\b|\b\d+ ?(?:h|hrs?|d|w)\b|\btime limit\b|\bservice level\b|\bturnaround\b|\bwithin\b`,
    ),
  },
  dispositionPolicy: { related: words(String.raw`\bdisposition\b`) },
  "dispositionPolicy.minConfidenceForAutoApply": {
    related: words(stems("confiden", "auto-?appl", "automatic", "certain")),
  },
  "dispositionPolicy.holdForTransitive": {
    related: words(`${stems("hold", "approv")}|\\btransitive\\b|\\bindirect\\b`),
  },
  "dispositionPolicy.escalateOnKev": {
    related: words(`${stems("escalat")}|\\bkev\\b|\\bknown[- ]exploited\\b`),
  },
  "dispositionPolicy.escalateOnSlaBreachSeverities": {
    related: words(`${stems("escalat", "breach")}|\\bsla\\b|\\boverdue\\b|${SEVERITY}`),
  },
  containmentMode: {
    related: words(
      `${stems("contain", "revert", "hold", "approv", "quarantin")}|\\broll(?:ed|ing)?[- ]?back\\b|\\bundo\\b`,
    ),
  },
  escalationGraph: {
    related: words(
      `${stems("escalat", "notif", "alert", "unresolved", "fail", "block")}|\\bissues?\\b|\\bdraft\\b|\\bpull requests?\\b|\\bprs?\\b|\\bhold\\b|\\bbranch\\b|\\bfollow-?up\\b|\\bnothing\\b|\\bpage\\b|\\bslack\\b|\\bno safe version\\b|${REASONS}`,
    ),
  },
  autonomy: {
    related: words(
      `${stems("autonom", "auto-?merg", "observ", "suggest", "merg", "trust")}|\\bceiling\\b|\\bl[0-4]\\b|\\bpull requests?\\b|\\bprs?\\b|\\blevel\\b|\\bunattended\\b`,
    ),
  },
};

/** The entries that speak for `path`: its own and its descendants'; failing that, the nearest ancestor's. */
function entriesFor(path: string): Entry[] {
  const own = Object.entries(TABLE).filter(([key]) => key === path || key.startsWith(`${path}.`));
  if (own.length > 0) return own.map(([, entry]) => entry);
  const parent = path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : "";
  return parent === "" ? [] : entriesFor(parent);
}

/** Whether `path` has any vocabulary at all (every key a model may touch must). */
export const hasVocabulary = (path: string): boolean => entriesFor(path).length > 0;

/**
 * Whether the words of `text` are about the policy key `path` (`related`) or ask for it to be loosened
 * (`loosen`), on whole words. The key's own name also counts, so a request that says `denyPackages`
 * is understood.
 */
export function mentionsKey(path: string, kind: "related" | "loosen", text: string): boolean {
  const normalised = tokensOf(text).join(" ");
  const entries = entriesFor(path);
  if (entries.length === 0) return false;
  const name = (path.split(".").pop() ?? "").toLowerCase().replaceAll("-", "[- ]");
  if (new RegExp(`\\b${name}\\b`, "u").test(normalised)) return true;
  return entries.some((entry) =>
    (kind === "loosen" ? (entry.loosen ?? entry.related) : entry.related).test(normalised),
  );
}
