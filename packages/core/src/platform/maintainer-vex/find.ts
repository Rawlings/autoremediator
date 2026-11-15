import type { MaintainerVexEvidence, MaintainerVexIgnored } from "../types.js";
import type { OpenVexStatement } from "./openvex.js";
import { dependsOn, type MaintainerVexIndex, type ShippedStatement } from "./read.js";

export interface MaintainerVexMatch {
  /** Accepted `not_affected` statements with a justification. */
  evidence: MaintainerVexEvidence[];
  /** Statements that named this advisory but were not accepted, and why. */
  ignored: MaintainerVexIgnored[];
}

const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

function names(statement: OpenVexStatement): Set<string> {
  const all = new Set<string>([statement.vulnerability.name.toUpperCase()]);
  for (const alias of statement.vulnerability.aliases ?? []) all.add(alias.toUpperCase());
  return all;
}

function stamp(statement: OpenVexStatement, documentTimestamp: string): number {
  const parsed = Date.parse(statement.timestamp ?? documentTimestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Which installed packages vouch that the advisory does not affect them, for this vulnerable copy.
 *
 * A statement counts only when all of these hold:
 *  - it comes from a package other than the vulnerable one (a package cannot declare itself not
 *    affected by an advisory about itself: that claim is made by the party it concerns),
 *  - the maintaining package depends, through installed packages, on the vulnerable one,
 *  - if it lists subcomponents, one is the vulnerable package (any version, or this exact version),
 *  - it is the newest statement on this advisory from that document for that product, and says
 *    `not_affected` with a justification from the OpenVEX list.
 * Anything else that named the advisory is returned under `ignored` with the reason.
 */
export function findMaintainerVex(
  index: MaintainerVexIndex,
  advisoryId: string,
  vulnerable: { name: string; version: string },
  now: Date = new Date(),
): MaintainerVexMatch {
  const wanted = advisoryId.toUpperCase();
  const evidence: MaintainerVexEvidence[] = [];
  const ignored: MaintainerVexIgnored[] = [];

  for (const shipped of index.documents) {
    const maintainer = shipped.package;
    const candidates: ShippedStatement[] = shipped.statements.filter((entry) =>
      names(entry.statement).has(wanted),
    );
    if (candidates.length === 0) continue;
    const skip = (reason: string) => ignored.push({ maintainer, reason });

    // A package nested inside the vulnerable one's own tree is part of it: it can bundle a helper that
    // "depends on" its host and vouches for it, so its claim is no more independent than the host's.
    const inside = `/node_modules/${vulnerable.name}/`;
    if (shipped.dir.replaceAll("\\", "/").includes(inside)) {
      skip(
        `${maintainer.name}@${maintainer.version} is shipped inside ${vulnerable.name} itself, so it is not an independent maintainer`,
      );
      continue;
    }
    if (maintainer.name === vulnerable.name) {
      skip(
        `${maintainer.name}@${maintainer.version} declares itself not affected by an advisory about ${vulnerable.name}; a package's own claim about itself is never accepted`,
      );
      continue;
    }
    if (!dependsOn(index, maintainer.name, vulnerable.name)) {
      skip(`${maintainer.name} does not depend on ${vulnerable.name}`);
      continue;
    }
    const about = candidates.filter(
      (entry) =>
        entry.subcomponents === undefined ||
        entry.subcomponents.some(
          (sub) =>
            sub.name === vulnerable.name &&
            (sub.version === undefined || sub.version === vulnerable.version),
        ),
    );
    // Statements about a different subcomponent concern something else; not worth reporting.
    if (about.length === 0) continue;

    const dated = about.filter(
      (entry) => stamp(entry.statement, shipped.document.timestamp) <= now.getTime() + FUTURE_SKEW_MS,
    );
    if (dated.length === 0) {
      skip(`${maintainer.name}@${maintainer.version} dates its statement in the future`);
      continue;
    }
    // Newest statement wins; on a tie, a statement that is not `not_affected` wins, then the higher version.
    const latest = dated.toSorted((a, b) => {
      const byTime = stamp(b.statement, shipped.document.timestamp) - stamp(a.statement, shipped.document.timestamp);
      if (byTime !== 0) return byTime;
      const aOk = a.statement.status === "not_affected" ? 1 : 0;
      const bOk = b.statement.status === "not_affected" ? 1 : 0;
      if (aOk !== bOk) return aOk - bOk;
      return (b.statement.version ?? 0) - (a.statement.version ?? 0);
    })[0]!;
    const { statement } = latest;
    if (statement.status !== "not_affected") {
      skip(`${maintainer.name}@${maintainer.version} says ${statement.status}, not not_affected`);
      continue;
    }
    if (statement.justification === undefined) {
      skip(
        `${maintainer.name}@${maintainer.version} gives only a free-text impact statement, no OpenVEX justification`,
      );
      continue;
    }
    evidence.push({
      maintainer,
      file: shipped.file,
      documentId: shipped.document["@id"],
      author: shipped.document.author,
      ...(statement["@id"] ? { statementId: statement["@id"] } : {}),
      status: "not_affected",
      justification: statement.justification,
      ...(statement.impact_statement ? { impactStatement: statement.impact_statement } : {}),
      ...(statement.status_notes ? { statusNotes: statement.status_notes } : {}),
      timestamp: statement.timestamp ?? shipped.document.timestamp,
      subcomponent: latest.subcomponents !== undefined,
    });
  }
  // One maintainer saying the advisory affects the package outweighs another saying it does not:
  // acting on "not affected" needs nobody installed to disagree.
  const disagreement = ignored.find((entry) => /says (affected|under_investigation|fixed)\b/.test(entry.reason));
  if (disagreement && evidence.length > 0) {
    for (const claim of evidence.splice(0)) {
      ignored.push({
        maintainer: claim.maintainer,
        reason: `${claim.maintainer.name}@${claim.maintainer.version} says not_affected, but ${disagreement.maintainer.name}@${disagreement.maintainer.version} says otherwise, so neither is acted on`,
      });
    }
  }
  return { evidence, ignored };
}
