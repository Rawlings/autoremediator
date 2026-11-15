import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import { parse as yamlParse } from "yaml";

import { getModelSpec } from "../../infra/config.js";
import { loadPolicy } from "../../infra/policy/policy.js";
import type { AutoremediatorPolicy } from "../../infra/policy/policy.js";
import { isRecord } from "../../shared/guards.js";
import { sha256 } from "../../shared/hash.js";
import { renderDiff } from "../init/diff.js";
import { resolveLanguageModel } from "../patch/model.js";
import { applyPatch, PolicyPatchError } from "./apply-patch.js";
import { describePolicy } from "./explain.js";
import { findLoosenings, type Loosening } from "./policy-loosening.js";
import { buildPolicyPrompt, POLICY_SYSTEM_PROMPT } from "./prompt.js";
import { policySchemas, type PolicyProposal } from "./proposal.js";
import { clausesOf, findPhrase, indexRequest, isNegated, tokensOf } from "./request-match.js";
import { PolicyRequestError, sanitizeRequest } from "./sanitize.js";
import { hasVocabulary, mentionsKey } from "./vocabulary.js";

export const DEFAULT_POLICY_PATH = join(".github", "autoremediator.yml");

/** What a proposer receives: the instructions, and the prompt that carries the (untrusted) request. */
export interface ProposerInput {
  system: string;
  prompt: string;
}

/**
 * Anything that turns the prompt into a proposed patch. The default calls a language model with
 * schema-constrained output; tests and embedders pass their own. Its answer is untrusted: it is
 * validated against the proposal schema again before anything uses it.
 */
export type PolicyProposer = (input: ProposerInput) => Promise<unknown>;

/** The model answered, but not in the shape the policy allows. Reported as a rejection, not a crash. */
export class ProposalRejectedError extends Error {
  override readonly name = "ProposalRejectedError";
}

/** A proposer backed by an AI SDK language model using structured output. */
export function createModelProposer(model: LanguageModel): PolicyProposer {
  return async ({ system, prompt }) => {
    try {
      const { output } = await generateText({
        model,
        output: Output.object({ schema: policySchemas().proposal }),
        system,
        prompt,
        temperature: 0,
      });
      return output;
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        const reason = error.cause instanceof Error ? error.cause.message : error.message;
        throw new ProposalRejectedError(
          `The model's answer is not a valid policy patch: ${reason.slice(0, 600)}`,
          { cause: error },
        );
      }
      throw error;
    }
  };
}

export interface CompilePolicyOptions {
  /** Project directory (default: process.cwd()). */
  cwd?: string;
  /** Policy file to change, relative to `cwd` (default: `.github/autoremediator.yml`). Inline policy text is not accepted. */
  policy?: string;
  /** Model as `<provider>:<model-id>` (default: `AUTOREMEDIATOR_MODEL`). */
  model?: string;
  /** Write the file when the proposal is valid. Without it nothing is written. */
  apply?: boolean;
  /** Accept loosenings the request asks for. Without it any loosening rejects the proposal. */
  allowLoosening?: boolean;
  /** Use this language model instead of resolving `model`. */
  languageModel?: LanguageModel;
  /** Use this proposer instead of a model (tests, embedding). */
  proposer?: PolicyProposer;
  /** The clock for suppression expiry checks (default: now). */
  now?: Date;
}

export interface PolicyExplanation {
  phrase: string;
  keys: string[];
  /** `changes`: the proposal changes at least one of these keys. `already-in-place`: the policy already says this. */
  effect: "changes" | "already-in-place";
}

export interface PolicyCompileResult {
  /**
   * `proposed`: valid, would change the file. `unchanged`: valid, nothing to change.
   * `rejected`: refused, see `rejections` and `loosenings`. `applied`: written.
   */
  status: "proposed" | "unchanged" | "rejected" | "applied";
  /** The policy file, relative to `cwd`. */
  path: string;
  /** The request after cleaning; this is what the model saw. */
  request: string;
  changed: boolean;
  applied: boolean;
  /** Unified diff of the file; empty when nothing changes. Shown for a rejected proposal too, so a reviewer can see what was refused. */
  diff: string;
  /** The full proposed file. Present whenever a patch could be applied. */
  proposed?: string;
  /** Fingerprint of the file the proposal was made against (`absent` when there was none); a write is refused if the file has changed since. */
  base: string;
  explanations: PolicyExplanation[];
  /** Phrases that could not be expressed, from the model and from the deterministic coverage check. */
  unsupported: { phrase: string; reason: string }[];
  /** Each way the proposed policy is less safe than the current one. */
  loosenings: Loosening[];
  rejections: string[];
  warnings: string[];
  /** The proposed policy in plain sentences. */
  sentences: string[];
  model?: string;
}

const fingerprint = (text: string | undefined): string =>
  text === undefined ? "absent" : sha256(text);

/** Whether a file's line breaks are mostly CRLF (a Windows checkout), so what is written can match. */
const lf = (text: string | undefined) => text?.replaceAll("\r\n", "\n");

const usesCrlf = (text: string | undefined): boolean =>
  text !== undefined &&
  (text.match(/\r\n/g)?.length ?? 0) > (text.match(/(?<!\r)\n/g)?.length ?? 0);

/** CVE and GHSA ids as they appear in running text (lower-cased). */
const ADVISORY_ID_IN_TEXT =
  /(?<![\w-])(?:cve-\d{4}-\d{4,}|ghsa(?:-[23456789cfghjmpqrvwx]{4}){3})(?![\w-])/g;

/** Dotted paths whose value differs between two parsed policy files. Arrays are compared whole. */
export function changedPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((key) =>
      changedPaths(before[key], after[key], prefix === "" ? key : `${prefix}.${key}`),
    );
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
}

/** An explained key covers a change at, under, or (when a whole section is new) above it. */
const covers = (key: string, path: string): boolean =>
  path === key || path.startsWith(`${key}.`) || key.startsWith(`${path}.`);

function parseRaw(text: string | undefined): Record<string, unknown> {
  const parsed: unknown = text === undefined ? {} : (yamlParse(text) ?? {});
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function validatedPolicy(cwd: string, text: string): AutoremediatorPolicy {
  // Validate the parsed value as inline JSON: it needs no file and is what `loadPolicy` reads anyway.
  return loadPolicy(cwd, JSON.stringify(parseRaw(text)));
}

async function resolveProposer(
  options: CompilePolicyOptions,
): Promise<{ proposer: PolicyProposer; model?: string }> {
  if (options.proposer) return { proposer: options.proposer };
  if (options.languageModel) {
    const { languageModel } = options;
    return {
      proposer: createModelProposer(languageModel),
      model: typeof languageModel === "string" ? languageModel : languageModel.modelId,
    };
  }
  const spec = getModelSpec(options.model);
  if (!spec) {
    throw new PolicyRequestError(
      'Compiling a policy needs a model: pass `model` ("<provider>:<model-id>", for example "anthropic:claude-sonnet-5-5") or set AUTOREMEDIATOR_MODEL. The provider package (@ai-sdk/<provider>) must be installed and its API key set. `policy explain` needs no model.',
    );
  }
  return { proposer: createModelProposer(await resolveLanguageModel(spec)), model: spec };
}

/**
 * Turn plain-language rules into a validated change to the policy file.
 *
 * The model only proposes a patch over an allowlist of policy keys. Everything that makes the result
 * safe is deterministic code: the patch is applied to the YAML with comments kept, the result must
 * pass the same validation as `loadPolicy`, every change must be explained by words in the request,
 * and any loosening (`findLoosenings`) is refused unless the request asks for it and `allowLoosening`
 * is set. Nothing is written without `apply`, and a rejected proposal is never written.
 */
export async function compilePolicy(
  requestText: string,
  options: CompilePolicyOptions = {},
): Promise<PolicyCompileResult> {
  const request = sanitizeRequest(requestText);
  const cwd = resolve(options.cwd ?? process.cwd());
  const requested = options.policy?.trim() ? options.policy : DEFAULT_POLICY_PATH;
  if (/^(?:\{|---)/.test(requested.trim())) {
    throw new PolicyRequestError("Compiling needs a policy file path, not inline policy text.");
  }
  const target = resolve(cwd, requested);
  const path = relative(cwd, target) || requested;
  const now = options.now ?? new Date();

  const before = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  // The current policy must be valid: a broken file is reported, never papered over.
  const oldPolicy = loadPolicy(cwd, before === undefined ? undefined : target);
  const oldRaw = parseRaw(before);

  const result: PolicyCompileResult = {
    status: "rejected",
    path,
    request,
    base: fingerprint(before),
    changed: false,
    applied: false,
    diff: "",
    explanations: [],
    unsupported: [],
    loosenings: [],
    rejections: [],
    warnings: [],
    sentences: describePolicy(oldPolicy).map((rule) => rule.sentence),
  };
  const reject = (...reasons: string[]): PolicyCompileResult => {
    result.status = "rejected";
    result.rejections.push(...reasons);
    return result;
  };

  const { proposer, model } = await resolveProposer(options);
  if (model) result.model = model;

  let answer: unknown;
  try {
    answer = await proposer({
      system: POLICY_SYSTEM_PROMPT,
      prompt: buildPolicyPrompt({
        request,
        currentPolicy: oldRaw,
        today: now.toISOString().slice(0, 10),
      }),
    });
  } catch (error) {
    if (error instanceof ProposalRejectedError) return reject(error.message);
    throw error;
  }

  const { proposal: proposalSchema, keys: allowedKeys } = policySchemas();
  const parsed = proposalSchema.safeParse(answer);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return issue.code === "unrecognized_keys"
        ? `${where}: key(s) outside the allowlist: ${issue.keys.join(", ")}`
        : `${where}: ${issue.message}`;
    });
    return reject(
      `The model's answer is not a valid policy patch (allowed keys: ${allowedKeys.join(", ")}).`,
      ...issues,
    );
  }
  const proposal: PolicyProposal = parsed.data;

  // A phrase the model quotes must be in the request, word for word and in order, and must be about
  // the keys it claims to explain.
  const index = indexRequest(request);
  const quotedExplanations: { phrase: string; keys: string[] }[] = [];
  for (const entry of proposal.explanations) {
    for (const key of entry.keys) {
      if (!allowedKeys.includes(key.split(".")[0] ?? "") || !hasVocabulary(key)) {
        return reject(`The model explains a key outside the allowlist: "${key}".`);
      }
    }
    if (findPhrase(index, entry.phrase).length === 0) {
      result.warnings.push(
        `Ignored an explanation quoting words that are not in the request, in that order: "${entry.phrase.slice(0, 80)}".`,
      );
      continue;
    }
    const keys = entry.keys.filter((key) => mentionsKey(key, "related", entry.phrase));
    const unrelated = entry.keys.filter((key) => !keys.includes(key));
    if (unrelated.length > 0) {
      result.warnings.push(
        `Ignored "${entry.phrase.slice(0, 80)}" as the explanation for ${unrelated.join(", ")}: the words say nothing about it.`,
      );
    }
    if (keys.length > 0) quotedExplanations.push({ phrase: entry.phrase, keys });
  }
  const quotedUnsupported = proposal.unsupported.filter(
    (entry) => findPhrase(index, entry.phrase).length > 0,
  );
  result.unsupported = quotedUnsupported.map(({ phrase, reason }) => ({ phrase, reason }));

  // A suppression is for an advisory the request names, spelled out: never one the model chose.
  const requestIds = new Set(request.toLowerCase().match(ADVISORY_ID_IN_TEXT) ?? []);
  const invented = (proposal.patch.suppressions ?? [])
    .map((entry) => entry.cveId)
    .filter((id) => !requestIds.has(id.toLowerCase()));
  if (invented.length > 0) {
    return reject(`The model suppresses ${invented.join(", ")}, which the request does not name.`);
  }

  // Apply the patch to the YAML text.
  let proposed: string;
  let policy: AutoremediatorPolicy;
  try {
    const applied = applyPatch(before, proposal.patch, { now });
    // The YAML library writes LF; give the file back the line endings it had.
    proposed = usesCrlf(before) ? applied.text.replaceAll(/\r?\n/g, "\r\n") : applied.text;
    policy = validatedPolicy(cwd, proposed);
    const again = applyPatch(proposed, proposal.patch, { now });
    if (again.edits !== 0) {
      return reject("Applying the patch twice gives a different file, so it was refused.");
    }
  } catch (error) {
    if (
      error instanceof PolicyPatchError ||
      (error instanceof Error && error.message.startsWith("Invalid policy"))
    ) {
      return reject(error.message);
    }
    throw error;
  }
  result.proposed = proposed;
  result.changed = proposed !== (before ?? "");
  // The diff is line-based, so it compares LF text whatever the file's own line endings are.
  result.diff = result.changed ? renderDiff(path, lf(before), lf(proposed) ?? "") : "";
  result.sentences = describePolicy(policy).map((rule) => rule.sentence);

  // Every change must be explained by words of the request that are about it.
  const newRaw = parseRaw(proposed);
  const changed = changedPaths(oldRaw, newRaw);
  const stray = changed.filter(
    (changedPath) => !allowedKeys.includes(changedPath.split(".")[0] ?? ""),
  );
  if (stray.length > 0) {
    return reject(`The change touches keys outside the allowlist: ${stray.join(", ")}.`);
  }
  // Loosening: what the proposal makes less safe, found by comparing the two policies.
  const loosenings = findLoosenings(oldPolicy, policy);
  result.loosenings = loosenings;
  const unexplained = changed.filter(
    (changedPath) =>
      !quotedExplanations.some((entry) => entry.keys.some((key) => covers(key, changedPath))) &&
      // A loosening is refused with its own reason below.
      !loosenings.some((entry) => covers(entry.key, changedPath)),
  );
  if (unexplained.length > 0) {
    return reject(
      `The model changed ${unexplained.join(", ")} without quoting the words of the request that ask for it.`,
    );
  }
  result.explanations = quotedExplanations.map((entry) => ({
    phrase: entry.phrase,
    keys: entry.keys,
    effect: changed.some((changedPath) => entry.keys.some((key) => covers(key, changedPath)))
      ? "changes"
      : "already-in-place",
  }));

  // Rules the model neither expressed nor reported as unsupported are surfaced, never dropped silently.
  const mentioned = new Set(
    [
      ...quotedExplanations.map((entry) => entry.phrase),
      ...quotedUnsupported.map((entry) => entry.phrase),
    ].flatMap((phrase) => tokensOf(phrase)),
  );
  for (const clause of clausesOf(request)) {
    const tokens = tokensOf(clause);
    const hit = tokens.filter((token) => mentioned.has(token)).length;
    if (hit / tokens.length < 0.7) {
      result.unsupported.push({
        phrase: clause,
        reason:
          "The model's answer does not account for these words, so nothing was changed for them.",
      });
    }
  }

  // A loosening must be asked for in so many words: a quoted phrase that is about that very key, says
  // so in loosening terms, and is not negated by the request ("never allow major bumps").
  const refusals: string[] = [];
  for (const entry of loosenings) {
    const asking = quotedExplanations.filter(
      (explanation) =>
        explanation.keys.some((key) => covers(key, entry.key)) &&
        mentionsKey(entry.key, "loosen", explanation.phrase),
    );
    if (asking.length === 0) {
      refusals.push(
        `Refused: ${entry.description} (${entry.key}) The request does not ask for it.`,
      );
      continue;
    }
    const positive = asking.some((explanation) =>
      findPhrase(index, explanation.phrase).some(
        (start) => !isNegated(index, start, tokensOf(explanation.phrase).length),
      ),
    );
    if (!positive) {
      refusals.push(
        `Refused: ${entry.description} (${entry.key}) The request says the opposite: "${asking[0]?.phrase.slice(0, 80)}" is negated there.`,
      );
    }
  }
  if (refusals.length > 0) return reject(...refusals);
  if (loosenings.length > 0 && options.allowLoosening !== true) {
    return reject(
      `The proposal makes the policy less safe in ${loosenings.length} way(s); review them and run again with allowLoosening (--allow-loosening) if you mean it.`,
      ...loosenings.map((entry) => `${entry.key}: ${entry.description}`),
    );
  }

  if (!result.changed) {
    result.status = "unchanged";
    return result;
  }
  result.status = "proposed";

  if (options.apply === true) writePolicyProposal(result, { cwd });
  return result;
}

/**
 * Write a proposal that `compilePolicy` returned, exactly as it was shown. Refuses a rejected or empty
 * proposal, and one whose file has changed since it was made. Used by `compilePolicy` with `apply`
 * and by the CLI after the person confirms, so a second model call can never write something they did
 * not review.
 */
export function writePolicyProposal(
  result: PolicyCompileResult,
  options: { cwd?: string } = {},
): PolicyCompileResult {
  if (result.status !== "proposed" || result.proposed === undefined) {
    throw new Error(`Only a proposed change can be written (this one is ${result.status}).`);
  }
  const target = resolve(options.cwd ?? process.cwd(), result.path);
  const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  if (fingerprint(current) !== result.base) {
    throw new Error(`${result.path} changed since the proposal was made; run the command again.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, result.proposed, "utf8");
  result.status = "applied";
  result.applied = true;
  return result;
}
