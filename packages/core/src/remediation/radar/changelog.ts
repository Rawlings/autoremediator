/**
 * Changelog and release-note signals: split release history into per-version sections, then score
 * each line with a fixed vocabulary of security terms. Matching is by word boundary, negation is
 * understood ("no security issues", "not a vulnerability"), and the text only ever contributes by
 * which fixed terms it contains, never by what it asks for.
 */
import semver from "semver";

import { evidenceLine, sanitizeEvidence } from "./sanitize.js";
import { RADAR_POINTS, type RadarFlag } from "./types.js";

type Strength = "strong" | "medium" | "mild";

interface Term {
  id: string;
  pattern: RegExp;
  strength: Strength;
  /**
   * A bare word that is often an identifier or a package name (`escape`, `eslint-plugin-security`):
   * ignored inside code spans and when joined to a name with `-`, `/` or `@`.
   */
  bare?: boolean;
  /** The match describes a defect in the past participle ("was not escaped"), so a negator makes it more, not less, relevant. */
  participle?: boolean;
}

const TERMS: readonly Term[] = [
  { id: "cve", pattern: /\bCVE-\d{4}-\d{4,}\b/gi, strength: "strong" },
  { id: "ghsa", pattern: /\bGHSA(?:-[23456789cfghjmpqrvwx]{4}){3}\b/gi, strength: "strong" },
  { id: "prototype-pollution", pattern: /\bprototype[- ]pollution\b/gi, strength: "strong" },
  { id: "redos", pattern: /\bredos\b/gi, strength: "strong" },
  {
    id: "regex-dos",
    pattern: /\b(?:regex(?:p)?|regular expression)s? denial[- ]of[- ]service\b/gi,
    strength: "strong",
  },
  { id: "backtracking", pattern: /\bcatastrophic backtracking\b/gi, strength: "strong" },
  { id: "path-traversal", pattern: /\b(?:path|directory) traversal\b/gi, strength: "strong" },
  { id: "ssrf", pattern: /\bssrf\b/gi, strength: "strong" },
  {
    id: "xss",
    pattern: /\bxss\b|\bcross[- ]site[- ]scripting\b/gi,
    strength: "strong",
    bare: true,
  },
  {
    id: "injection",
    pattern:
      /\b(?:command|code|sql|shell|template|html|script|header|argument|os command) injection\b/gi,
    strength: "strong",
  },
  { id: "rce", pattern: /\bremote code execution\b|\bRCE\b/g, strength: "strong" },
  {
    id: "arbitrary",
    pattern: /\barbitrary (?:code|command|file|script)s?\b/gi,
    strength: "strong",
  },
  { id: "xxe", pattern: /\bxxe\b|\bxml external entit(?:y|ies)\b/gi, strength: "strong" },
  { id: "open-redirect", pattern: /\bopen redirect\b/gi, strength: "strong" },
  {
    id: "security-fix",
    pattern:
      /\bsecurity[- ](?:fix(?:es)?|patch(?:es)?|vulnerabilit(?:y|ies)|advisor(?:y|ies)|issues?|bugs?|holes?|updates?|releases?)\b/gi,
    strength: "strong",
  },
  { id: "vulnerability", pattern: /\bvulnerab(?:le|ility|ilities)\b/gi, strength: "medium" },
  { id: "security", pattern: /\bsecurity\b/gi, strength: "medium", bare: true },
  { id: "exploit", pattern: /\bexploit(?:s|ed|able|ation)?\b/gi, strength: "medium" },
  { id: "dos", pattern: /\bdenial[- ]of[- ]service\b|\bDoS\b/g, strength: "medium" },
  { id: "csrf", pattern: /\bcsrf\b/gi, strength: "medium" },
  { id: "timing", pattern: /\btiming (?:attacks?|side[- ]channels?)\b/gi, strength: "medium" },
  {
    id: "overflow",
    pattern: /\bbuffer (?:over(?:flow|run)|over-read)\b|\bout[- ]of[- ]bounds\b/gi,
    strength: "medium",
  },
  {
    id: "disclosure",
    pattern: /\binformation (?:disclosure|leak)\b|\b(?:secret|token|credential|password)s? leak/gi,
    strength: "medium",
  },
  {
    id: "escalation",
    pattern: /\bprivilege escalation\b|\bsandbox escape\b/gi,
    strength: "medium",
  },
  { id: "insecure", pattern: /\binsecure(?:ly)?\b/gi, strength: "medium", participle: true },
  { id: "sanitize", pattern: /\bsaniti[sz]\w*/gi, strength: "mild", bare: true, participle: true },
  {
    id: "escape",
    pattern: /\bescap(?:e|es|ed|ing)\b/gi,
    strength: "mild",
    bare: true,
    participle: true,
  },
  { id: "unsafe", pattern: /\bunsafe(?:ly)?\b/gi, strength: "mild", bare: true, participle: true },
  { id: "malicious", pattern: /\bmalicious(?:ly)?\b/gi, strength: "mild" },
  { id: "untrusted", pattern: /\buntrusted\b/gi, strength: "mild" },
  { id: "attacker", pattern: /\battack(?:er|ers|s)?\b/gi, strength: "mild", bare: true },
  { id: "harden", pattern: /\bharden(?:ed|ing)?\b/gi, strength: "mild" },
  {
    id: "validate",
    pattern: /\bvalidat(?:e|es|ed|ing|ion)\b/gi,
    strength: "mild",
    bare: true,
    participle: true,
  },
];

/** Phrases that look like a term but are not security: matched ranges are removed before matching. */
const NOT_SECURITY = /\bmemory[- ]leaks?\b|\bsecurity[- ]?(?:conscious)\b|\bnon-?security\b/gi;

const NEGATORS =
  /\b(?:no|not|non|without|never|nothing|none|neither|nor|cannot|n\/a|unrelated|irrelevant)(?![-\w])|\b\w+n't\b|\bfree of\b|\black(?:s|ing)? of\b/i;
const POST_NEGATION =
  /^\W*(?:\w+\W+){0,2}?(?:none|n\/a|nil|not (?:affected|applicable|relevant|related|a concern)|unaffected)\b/i;
const NO_LONGER = /\bno longer\s+(?:\w+\s+){0,2}$/i;
const NOT_PARTICIPLE = /\b(?:not|never|n't)\s+(?:\w+\s+){0,2}$/i;

const WEIGHTS = RADAR_POINTS.changelog;
const STRENGTH_POINTS: Record<Strength, number> = {
  strong: WEIGHTS.strongTerm,
  medium: WEIGHTS.mediumTerm,
  mild: WEIGHTS.mildTerm,
};

export interface ClassifiedLine {
  /** 1-based line within the document the text came from. */
  line: number;
  text: string;
  points: number;
  terms: string[];
}

function blankOut(text: string, pattern: RegExp): string {
  return text.replaceAll(pattern, (match) => " ".repeat(match.length));
}

function inCodeSpan(text: string, index: number): boolean {
  let open = false;
  for (let position = 0; position < index; position++) if (text[position] === "`") open = !open;
  return open;
}

function joinedToName(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const after = text[end];
  if (before === "@" || before === "/" || after === "/" || before === "_" || after === "_")
    return true;
  const wordChar = /[a-z0-9]/i;
  if (before === "-" && wordChar.test(text[start - 2] ?? "")) return true;
  if (after === "-" && wordChar.test(text[end + 1] ?? "")) return true;
  return false;
}

const CLAUSE_BREAK = /[.;!?,:()\u2014]|\bbut\b|\bhowever\b| - /gi;

function clauseBefore(text: string, index: number): string {
  const head = text.slice(0, index);
  let boundary = 0;
  for (const match of head.matchAll(CLAUSE_BREAK)) boundary = match.index + match[0].length;
  // Only the last few words matter: "no" at the start of a long sentence is not about this term.
  return head.slice(boundary).split(/\s+/).slice(-6).join(" ");
}

function isNegated(text: string, term: Term, start: number, end: number): boolean {
  const before = clauseBefore(text, start);
  if (NO_LONGER.test(before)) return false;
  if (!NEGATORS.test(before) && !POST_NEGATION.test(text.slice(end))) return false;
  // "values were not escaped" describes the defect that was fixed.
  if (term.participle && NOT_PARTICIPLE.test(before) && /(?:ed|d)$/i.test(text.slice(start, end))) {
    return false;
  }
  return true;
}

/** Score one line of release text with the fixed vocabulary. Zero when nothing relevant, or all negated. */
export function classifyLine(text: string): { points: number; terms: string[] } {
  const scrubbed = blankOut(text, NOT_SECURITY);
  const found = new Map<string, number>();
  for (const term of TERMS) {
    for (const match of scrubbed.matchAll(term.pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (term.bare && (inCodeSpan(scrubbed, start) || joinedToName(scrubbed, start, end)))
        continue;
      if (isNegated(scrubbed, term, start, end)) continue;
      found.set(term.id, STRENGTH_POINTS[term.strength]);
      break;
    }
  }
  if (found.size === 0) return { points: 0, terms: [] };
  const weights = [...found.values()].toSorted((a, b) => b - a);
  const extra = Math.min(2, weights.length - 1) * WEIGHTS.extraTermOnLine;
  return { points: (weights[0] ?? 0) + extra, terms: [...found.keys()].toSorted() };
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

export interface ChangelogSection {
  version: string;
  /** 1-based line of the heading. */
  startLine: number;
  lines: Array<{ line: number; text: string }>;
}

const VERSION_AT_START = /^\[?(?:v|version\s+|release\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/i;
const DATE_TAIL =
  /^\s*(?:[-–—/:|,(]\s*)?(?:\(?\[?\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\]?\)?|\(?[A-Za-z]+\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}\)?|\(?\d{1,2} [A-Za-z]+\.? \d{4}\)?|\(.*\)|\[.*\])?\s*$/;

function headerVersion(line: string, next: string | undefined): string | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.length > 140) return undefined;
  const isMarkdownHeading = /^#{1,6}\s/.test(trimmed);
  const body = trimmed
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[*_]{1,3}/, "")
    .replaceAll(/<a\b[^>]*>\s*<\/a>/gi, "")
    .replace(/^<a\b[^>]*>/i, "")
    .trim();
  const match = VERSION_AT_START.exec(body);
  const version = match?.[1];
  if (!version || !semver.valid(version)) return undefined;
  if (isMarkdownHeading) return version;
  // Without a `#`, only a line that is nothing but a version and a date, or is underlined, is a header.
  const rest = body.slice(match[0].length).replace(/[*_]+$/, "");
  const underlined = next !== undefined && /^\s*(?:={3,}|-{3,})\s*$/.test(next);
  return underlined || DATE_TAIL.test(rest) ? version : undefined;
}

/** Split release history into one section per version found in its headings. */
export function parseChangelog(text: string): ChangelogSection[] {
  const lines = text.split(/\r?\n/);
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | undefined;
  for (const [index, raw] of lines.entries()) {
    const version = headerVersion(raw, lines[index + 1]);
    if (version) {
      current = { version, startLine: index + 1, lines: [] };
      sections.push(current);
      continue;
    }
    // A heading with no version ends the section only when it is a top-level one (`# Changelog`).
    if (current && raw.trim() !== "") current.lines.push({ line: index + 1, text: raw });
  }
  return sections;
}

const SECURITY_HEADING =
  /^\s{0,3}(?:#{1,6}\s*)?(?:[*_]{1,2})?\s*security(?:\s+(?:fix(?:es)?|updates?|notes?))?\s*(?:[*_]{1,2})?\s*:?\s*$/i;
const ANY_HEADING = /^\s{0,3}(?:#{1,6}\s+\S|[*_]{2}[^*_]+[*_]{2}\s*:?\s*$)/;
const NOTHING = /^\W*(?:none|n\/a|nil|nothing|no\b.*|not applicable)\W*$/i;

function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
}

/** Lines of a section that look security-relevant, best first. */
export function classifySection(section: ChangelogSection): ClassifiedLine[] {
  const hits: ClassifiedLine[] = [];
  let underSecurity = false;
  for (const { line, text } of section.lines) {
    if (SECURITY_HEADING.test(text)) {
      underSecurity = true;
      continue;
    }
    if (ANY_HEADING.test(text)) underSecurity = false;
    const body = stripBullet(text);
    if (body === "") continue;
    const classified = classifyLine(body);
    let points = classified.points;
    const terms = [...classified.terms];
    if (underSecurity && !NOTHING.test(body)) {
      if (points < WEIGHTS.securityHeading) points = WEIGHTS.securityHeading;
      terms.push("security-heading");
    }
    if (points > 0) hits.push({ line, text: body, points, terms: terms.toSorted() });
  }
  return hits.toSorted((a, b) => b.points - a.points || a.line - b.line);
}

export interface ChangelogSignalInput {
  /** Document name for locations, e.g. `CHANGELOG.md` or `GitHub release`. */
  source: string;
  sections: ChangelogSection[];
  from: string;
  to: string;
}

/** Flags for the releases in `(from, to]`: the best few lines of each release that scored at all. */
export function changelogFlags(input: ChangelogSignalInput): RadarFlag[] {
  const flags: RadarFlag[] = [];
  const seen = new Set<string>();
  for (const section of input.sections) {
    if (!semver.gt(section.version, input.from) || !semver.lte(section.version, input.to)) continue;
    // The same version listed twice (a duplicated heading) is read once.
    if (seen.has(section.version)) continue;
    seen.add(section.version);
    const best = classifySection(section).slice(0, WEIGHTS.linesPerRelease);
    for (const line of best) {
      flags.push({
        category: "changelog",
        signal: `changelog:${line.terms.join("+")}`,
        release: section.version,
        points: line.points,
        location: sanitizeEvidence(`${input.source}:${line.line}`, 120),
        evidence: evidenceLine(`${input.source}:${line.line}`, `"${line.text}"`),
        occurrences: 1,
      });
    }
  }
  return flags;
}

/** Whether any text mentions security with a strong or medium term, un-negated. Used for deprecation notices. */
export function mentionsSecurity(text: string): boolean {
  return classifyLine(text).points >= WEIGHTS.mediumTerm;
}
