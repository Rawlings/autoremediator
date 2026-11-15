/**
 * Compare the public API surface of two versions of a package and list what a consumer could
 * trip over: removed or renamed exports and members, changed signatures, changed types.
 *
 * Severity is deliberately coarse. `breaking` is a change that makes an existing, correct use fail
 * (a removed export, a new required argument). `possibly-breaking` is a change that may or may not
 * matter to a given caller (a type text that changed, which could be a widening). The text of both
 * sides is always kept so the reader can judge.
 */
import type { ApiMember, ApiSurface, ApiSymbol, Signature } from "./dts-surface.js";

export type ChangeSeverity = "breaking" | "possibly-breaking";

export type ApiChangeCategory =
  | "removed-export"
  | "renamed-export"
  | "kind-changed"
  | "signature-changed"
  | "type-changed"
  | "removed-member"
  | "renamed-member"
  | "member-changed"
  | "added-required-member"
  | "extends-changed";

export interface ApiChange {
  specifier: string;
  /** Export name (`default` for a default export). */
  symbol: string;
  /** Member key within the symbol, when the change is to a member. */
  member?: string;
  /** Class, interface or namespace members versus the export itself. */
  memberOf?: "class" | "interface" | "namespace" | "enum" | "object";
  category: ApiChangeCategory;
  severity: ChangeSeverity;
  /** What changed, in one sentence. */
  reason: string;
  before?: string;
  after?: string;
  /** New call shape for a function, for checking call sites. */
  arity?: { min: number; max: number };
  /** New name, for a rename. */
  renamedTo?: string;
}

function arityOf(signature: Signature): { min: number; max: number } {
  const hasRest = signature.params.some((param) => param.rest);
  const min = signature.params.filter((param) => !param.optional && !param.rest).length;
  return { min, max: hasRest ? Number.POSITIVE_INFINITY : signature.params.length };
}

function describeArity(arity: { min: number; max: number }): string {
  return arity.max === Number.POSITIVE_INFINITY
    ? `${arity.min}+`
    : arity.min === arity.max
      ? `${arity.min}`
      : `${arity.min}-${arity.max}`;
}

interface SignatureFinding {
  category: ApiChangeCategory;
  severity: ChangeSeverity;
  reason: string;
  before?: string;
  after?: string;
  arity?: { min: number; max: number };
}

function comparePair(before: Signature, after: Signature, typed: boolean): SignatureFinding[] {
  const findings: SignatureFinding[] = [];
  const oldArity = arityOf(before);
  const newArity = arityOf(after);
  // Without types a parameter count is only a hint: a JavaScript function may ignore extra
  // arguments or default a missing one.
  const countSeverity: ChangeSeverity = typed ? "breaking" : "possibly-breaking";

  if (newArity.min > oldArity.min) {
    findings.push({
      category: "signature-changed",
      severity: countSeverity,
      reason: `now requires at least ${newArity.min} argument${newArity.min === 1 ? "" : "s"} (was ${oldArity.min})`,
      before: before.text,
      after: after.text,
      arity: newArity,
    });
  } else if (newArity.max < oldArity.max) {
    findings.push({
      category: "signature-changed",
      severity: countSeverity,
      reason: `now accepts at most ${describeArity({ min: newArity.max, max: newArity.max })} argument${newArity.max === 1 ? "" : "s"} (was ${oldArity.max === Number.POSITIVE_INFINITY ? "any number" : oldArity.max})`,
      before: before.text,
      after: after.text,
      arity: newArity,
    });
  }
  if (!typed) return findings;

  const shared = Math.min(before.params.length, after.params.length);
  const typeChanges: string[] = [];
  for (let index = 0; index < shared; index++) {
    const oldParam = before.params[index];
    const newParam = after.params[index];
    if (!oldParam || !newParam) continue;
    if (
      oldParam.type !== undefined &&
      newParam.type !== undefined &&
      oldParam.type !== newParam.type
    ) {
      typeChanges.push(`\`${newParam.name}\`: ${oldParam.type} -> ${newParam.type}`);
    }
    if (oldParam.optional && !newParam.optional && !findings.some((finding) => finding.arity)) {
      findings.push({
        category: "signature-changed",
        severity: "breaking",
        reason: `parameter \`${newParam.name}\` is no longer optional`,
        before: before.text,
        after: after.text,
        arity: newArity,
      });
    }
  }
  if (typeChanges.length > 0) {
    findings.push({
      category: "type-changed",
      severity: "possibly-breaking",
      reason: `parameter type changed (${typeChanges.slice(0, 3).join("; ")}); it may be a widening`,
      before: before.text,
      after: after.text,
    });
  }
  if (
    before.returns !== after.returns &&
    before.returns !== undefined &&
    after.returns !== undefined
  ) {
    findings.push({
      category: "type-changed",
      severity: "possibly-breaking",
      reason: `return type changed (${before.returns} -> ${after.returns})`,
      before: before.text,
      after: after.text,
    });
  }
  if ((before.typeParams ?? "") !== (after.typeParams ?? "")) {
    findings.push({
      category: "type-changed",
      severity: "possibly-breaking",
      reason: `type parameters changed (${before.typeParams ?? "none"} -> ${after.typeParams ?? "none"})`,
      before: before.text,
      after: after.text,
    });
  }
  return findings;
}

/** Findings for one callable whose set of overload signatures changed. */
export function compareSignatures(
  before: Signature[],
  after: Signature[],
  typed: boolean,
): SignatureFinding[] {
  if (before.length === 0 || after.length === 0) return [];
  const afterTexts = new Set(after.map((signature) => signature.text));
  const beforeTexts = new Set(before.map((signature) => signature.text));
  const removed = before.filter((signature) => !afterTexts.has(signature.text));
  const added = after.filter((signature) => !beforeTexts.has(signature.text));
  if (removed.length === 0) return [];
  const [onlyRemoved] = removed;
  const [onlyAdded] = added;
  if (removed.length === 1 && added.length === 1 && onlyRemoved && onlyAdded) {
    return comparePair(onlyRemoved, onlyAdded, typed);
  }
  if (added.length === 0) {
    return [
      {
        category: "signature-changed",
        severity: "breaking",
        reason: `${removed.length === 1 ? "an overload was" : `${removed.length} overloads were`} removed`,
        before: removed.map((signature) => signature.text).join(" | "),
        after: after.map((signature) => signature.text).join(" | "),
      },
    ];
  }
  return [
    {
      category: "signature-changed",
      severity: "possibly-breaking",
      reason: "overloads changed",
      before: removed.map((signature) => signature.text).join(" | "),
      after: added.map((signature) => signature.text).join(" | "),
    },
  ];
}

function shapeOf(symbol: ApiSymbol): string {
  if (symbol.kind === "function")
    return `function:${symbol.signatures
      .map((s) => s.text)
      .toSorted()
      .join("|")}`;
  if (
    symbol.kind === "class" ||
    symbol.kind === "interface" ||
    symbol.kind === "namespace" ||
    symbol.kind === "enum"
  ) {
    return `${symbol.kind}:${[...symbol.members.values()]
      .map((m) => `${m.key}/${m.kind}/${m.signatures.map((s) => s.text).join(",")}/${m.type ?? ""}`)
      .toSorted()
      .join(";")}`;
  }
  return `${symbol.kind}:${symbol.type ?? ""}`;
}

function memberShape(member: ApiMember): string {
  return `${member.kind}/${member.optional}/${member.signatures.map((signature) => signature.text).join(",")}/${member.type ?? ""}`;
}

function memberChanges(
  specifier: string,
  name: string,
  before: ApiSymbol,
  after: ApiSymbol,
  typed: boolean,
): ApiChange[] {
  const changes: ApiChange[] = [];
  const memberOf =
    before.kind === "variable"
      ? "object"
      : before.kind === "class" ||
          before.kind === "interface" ||
          before.kind === "namespace" ||
          before.kind === "enum"
        ? before.kind
        : undefined;
  const removed = [...before.members.values()].filter((member) => !after.members.has(member.key));
  const added = [...after.members.values()].filter((member) => !before.members.has(member.key));
  const claimed = new Set<string>();

  for (const member of removed) {
    const twin = added.find(
      (candidate) =>
        !claimed.has(candidate.key) &&
        memberShape(candidate) === memberShape(member) &&
        candidate.static === member.static,
    );
    if (twin) {
      claimed.add(twin.key);
      changes.push({
        specifier,
        symbol: name,
        member: member.key,
        memberOf,
        category: "renamed-member",
        severity: "breaking",
        reason: `\`${member.name}\` is gone; \`${twin.name}\` has the same shape (probable rename)`,
        renamedTo: twin.name,
      });
    } else {
      changes.push({
        specifier,
        symbol: name,
        member: member.key,
        memberOf,
        category: "removed-member",
        severity: "breaking",
        reason: `member \`${member.name}\` was removed`,
        before: member.signatures[0]?.text ?? member.type,
      });
    }
  }

  for (const member of before.members.values()) {
    const next = after.members.get(member.key);
    if (!next) continue;
    if (member.kind !== next.kind) {
      changes.push({
        specifier,
        symbol: name,
        member: member.key,
        memberOf,
        category: "member-changed",
        severity: "breaking",
        reason: `member \`${member.name}\` changed from ${member.kind} to ${next.kind}`,
      });
      continue;
    }
    for (const finding of compareSignatures(member.signatures, next.signatures, typed)) {
      changes.push({
        specifier,
        symbol: name,
        member: member.key,
        memberOf,
        ...finding,
        category: "member-changed",
      });
    }
    if (member.type !== undefined && next.type !== undefined && member.type !== next.type) {
      changes.push({
        specifier,
        symbol: name,
        member: member.key,
        memberOf,
        category: "member-changed",
        severity: "possibly-breaking",
        reason: `type of \`${member.name}\` changed (${member.type} -> ${next.type})`,
        before: member.type,
        after: next.type,
      });
    }
    if (member.optional !== next.optional) {
      changes.push({
        specifier,
        symbol: name,
        member: member.key,
        memberOf,
        category: "member-changed",
        severity: "possibly-breaking",
        reason: next.optional
          ? `\`${member.name}\` became optional (may now be undefined)`
          : `\`${member.name}\` became required`,
      });
    }
    if (!member.readonly && next.readonly) {
      changes.push({
        specifier,
        symbol: name,
        member: member.key,
        memberOf,
        category: "member-changed",
        severity: "possibly-breaking",
        reason: `\`${member.name}\` became readonly`,
      });
    }
  }

  if (before.kind === "interface") {
    for (const member of added) {
      if (claimed.has(member.key) || member.optional || member.kind === "index") continue;
      changes.push({
        specifier,
        symbol: name,
        member: member.key,
        memberOf,
        category: "added-required-member",
        severity: "possibly-breaking",
        reason: `new required member \`${member.name}\` (breaks code that implements or constructs this interface)`,
      });
    }
  }
  return changes;
}

function typeLike(kind: string): boolean {
  return kind === "interface" || kind === "type";
}

/** Compare one exported symbol. */
function compareSymbol(
  specifier: string,
  name: string,
  before: ApiSymbol,
  after: ApiSymbol,
  typed: boolean,
): ApiChange[] {
  const changes: ApiChange[] = [];
  if (before.kind !== after.kind) {
    changes.push({
      specifier,
      symbol: name,
      category: "kind-changed",
      severity: typeLike(before.kind) && typeLike(after.kind) ? "possibly-breaking" : "breaking",
      reason: `export changed from ${before.kind} to ${after.kind}`,
      before: before.kind,
      after: after.kind,
    });
    return changes;
  }
  if (before.kind === "function") {
    for (const finding of compareSignatures(before.signatures, after.signatures, typed)) {
      changes.push({ specifier, symbol: name, ...finding });
    }
  }
  const hasMembers = before.members.size > 0 || after.members.size > 0;
  if (
    before.kind === "class" ||
    before.kind === "interface" ||
    before.kind === "namespace" ||
    before.kind === "enum" ||
    (before.kind === "variable" && hasMembers)
  ) {
    changes.push(...memberChanges(specifier, name, before, after, typed));
    if ((before.extends ?? "") !== (after.extends ?? "")) {
      changes.push({
        specifier,
        symbol: name,
        category: "extends-changed",
        severity: "possibly-breaking",
        reason: `base type changed (${before.extends ?? "none"} -> ${after.extends ?? "none"})`,
        before: before.extends,
        after: after.extends,
      });
    }
  }
  if (
    (before.kind === "type" || before.kind === "variable") &&
    before.type !== undefined &&
    after.type !== undefined &&
    before.type !== after.type
  ) {
    changes.push({
      specifier,
      symbol: name,
      category: "type-changed",
      severity: "possibly-breaking",
      reason: `${before.kind === "type" ? "type definition" : "variable type"} changed`,
      before: before.type,
      after: after.type,
    });
  }
  return changes;
}

/** Changes between two surfaces of the same entry point. */
export function compareSurfaces(
  specifier: string,
  before: ApiSurface,
  after: ApiSurface,
): ApiChange[] {
  const typed = before.source === "types" && after.source === "types";
  const changes: ApiChange[] = [];
  const removed = [...before.symbols.values()].filter((symbol) => !after.symbols.has(symbol.name));
  const added = [...after.symbols.values()].filter((symbol) => !before.symbols.has(symbol.name));
  const claimed = new Set<string>();

  for (const symbol of removed) {
    const twin = added.find(
      (candidate) =>
        !claimed.has(candidate.name) &&
        candidate.kind === symbol.kind &&
        shapeOf(candidate) === shapeOf(symbol),
    );
    if (twin && symbol.name !== "default") {
      claimed.add(twin.name);
      changes.push({
        specifier,
        symbol: symbol.name,
        category: "renamed-export",
        severity: "breaking",
        reason: `\`${symbol.name}\` is gone; \`${twin.name}\` has the same shape (probable rename)`,
        renamedTo: twin.name,
      });
    } else {
      changes.push({
        specifier,
        symbol: symbol.name,
        category: "removed-export",
        severity: "breaking",
        reason: `\`${symbol.name}\` is no longer exported`,
        before: symbol.signatures[0]?.text ?? symbol.type ?? symbol.kind,
      });
    }
  }
  for (const symbol of before.symbols.values()) {
    const next = after.symbols.get(symbol.name);
    if (next) changes.push(...compareSymbol(specifier, symbol.name, symbol, next, typed));
  }
  return changes;
}
