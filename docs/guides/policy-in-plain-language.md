# Policy in plain language

Write your rules as a sentence, get a reviewed change to `.github/autoremediator.yml`. And read the
policy back as sentences.

```sh
autoremediator policy compile "Never auto-merge majors in payments; KEV fixes within 24 hours; don't touch left-pad"
autoremediator policy explain
```

`compile` proposes, you review a diff, and nothing is written until you say so. `explain` needs no
model and no network.

## Compile

```sh
autoremediator policy compile <rules...> [--policy <path>] [--model <provider:id>] [--yes] [--allow-loosening] [--output-format text|json]
```

It prints what changes, which words of your request became which policy key, what it could not
express, anything that makes the policy less safe, and a unified diff. Then:

| Situation | Result |
| --------- | ------ |
| At a terminal, no `--yes` | Asks `Write <file>? [y/N]`; writes exactly the diff you saw |
| No terminal, no `--yes` | Writes nothing, exits **3** (a change is waiting for a yes) |
| `--yes` | Writes the proposal after the checks below pass |
| Proposal refused | Writes nothing, exits **1**, says why |
| Nothing to change | Exits 0 |

A model is needed: `--model <provider>:<model-id>` or `AUTOREMEDIATOR_MODEL`, with the matching
`@ai-sdk/<provider>` package installed and its API key set, as for patch generation. The current policy
and your request are sent to that provider and nowhere else; there is no Autoremediator backend. Use a
model you are content to show your policy to.

### What the model can and cannot do

A model never writes the policy. It returns a **patch** (a structured object, checked against a schema
derived from the real policy schema) over a fixed set of keys, and deterministic code does the rest:

1. **Allowlist.** Only `allowMajorBumps`, `denyPackages`, `allowPackages`, `constraints`,
   `exploitSignalOverride`, `suppressions`, `sla`, `dispositionPolicy`, `containmentMode`,
   `escalationGraph` and `autonomy.ceiling` can be set. Unknown keys, values the policy file would
   reject, and anything else (`recipes`, `patchConfidenceThresholds`, `skipUnreachable`) are refused.
   Package lists take only package names and `*` patterns; advisory ids must be CVE or GHSA ids.
2. **Applied to the YAML with its comments.** The patch is applied through the YAML Document API, so
   comments, key order and untouched lines stay. Applying it a second time changes nothing, and a
   request the policy already satisfies reports `unchanged`. A file with CRLF line endings stays CRLF.
3. **Validated.** The result must load with the same validation as any policy file.
4. **Every change must be explained.** For each change the model must quote the words of your request
   that ask for it. The quote must be a run of your words, in order and unbroken (not words picked
   from anywhere in the request), and it must be about the keys it explains: "the weather" cannot be
   the reason for `containmentMode`. A change it cannot trace to your words is refused. A suppression
   is only accepted for a CVE or GHSA id that your request spells out.
5. **Nothing is dropped silently.** A clause of your request that the model neither expressed nor
   reported is listed under "could not be expressed".
6. **No loosening you did not ask for.** See below.
7. **Text never reaches the file except as a suppression note.** Your request is cleaned (control and
   invisible characters removed, 2000 characters at most) and sent to the model as data. Your words are
   not copied into the YAML except in the `notes` of a suppression, which is cut to one line of 200
   characters. The model's output is parsed, never executed.

### What it cannot express

The policy has no per-directory, per-team or per-package-group scoping, and no deadline for KEV
findings beyond the per-severity `sla`. For the example above:

```
What each rule became:
  "Never auto-merge majors" -> allowMajorBumps, autonomy.ceiling
  "KEV fixes"               -> exploitSignalOverride.kev
  "don't touch left-pad"    -> denyPackages

Could not be expressed (not approximated, not written):
  - "in payments": The policy has no per-path or per-package-group scoping.
  - "within 24 hours": A deadline applies per severity (sla), not to KEV findings.
```

The part it can express is proposed; the part it cannot is reported rather than approximated.
(This output is what a model that follows the instructions returns; a different model may split the
rules differently.)

### Loosening

`findLoosenings(oldPolicy, newPolicy)` (and `isLoosening`) compares two loaded policies and reports
every way the new one is less safe: allowing major bumps, removing a deny entry or widening an
allowlist, switching off `directDependenciesOnly`, `preferVersionBump`, `typecheck`,
`requireProofOfFix`, a frozen lockfile or a supply-chain protection (or shortening the publish age),
turning off KEV or EPSS mandates or raising the EPSS threshold, adding or extending a suppression,
lengthening or removing an SLA deadline, skipping unreachable code, trusting maintainer VEX statements,
lowering a patch confidence threshold, loosening a freshness limit or ignoring more packages in it,
lowering the auto-apply
confidence, no longer holding transitive changes or escalating KEV or SLA breaches, turning off
containment, silencing an escalation, raising the autonomy ceiling or weakening how autonomy is
earned (including a smaller `autonomy.window`), and trusting a new recipe source. With no `autonomy` key the ceiling counts as `L2`.
Tightening is never reported.

- A loosening the request does not ask for is **always refused**, even with `--allow-loosening`. The
  model must quote words of your request that are about that very key and say it in loosening terms
  (for example, `typecheck` needs words such as "type check"; an SLA needs "deadline", "hours" or
  "days"), matched as whole words, so "package" is not "age" and "allow" is not "low". A phrase your
  request negates ("Never allow major bumps", "don't", "without", "no") does not count as asking for
  it. This is a second lock against a model that was talked into it by text inside your request, and
  it is a keyword check, not an understanding of intent: read the diff.
- A loosening the request does ask for is refused unless you pass `--allow-loosening`; with it, each
  one is listed under "LESS SAFE than before".
- A suppression needs a justification and an expiry that is in the future and within 366 days.
- The autonomy ceiling can be lowered freely; raising it counts as a loosening.

## Explain

```sh
autoremediator policy explain [--policy <path>] [--output-format text|json]
```

Describes the current policy as sentences, each tied to its key (`rules` in JSON). Deterministic: the
same policy gives the same text. With no policy file it describes the built-in defaults. A broken
policy is an error. Because it is deterministic it is also the oracle for `compile`: what `compile`
proposes, `explain` should read back as the rules you wrote.

## SDK, MCP and HTTP

| Surface | `compilePolicy` | `explainPolicy` |
| ------- | --------------- | --------------- |
| SDK | `compilePolicy(request, { apply, allowLoosening, model, ... })`, `writePolicyProposal(result)` | `explainPolicy({ cwd, policy })` |
| CLI | `policy compile` | `policy explain` |
| MCP tool | `compilePolicy` (proposal only) | `explainPolicy` |
| HTTP | `POST /policy/compile` (proposal only) | `POST /policy/explain` |

Over MCP and HTTP `compilePolicy` returns the diff and the proposed file but never writes: it has no
`apply` input, and both operations are read-only. The CLI and SDK write, after review.

The SDK takes `proposer` or `languageModel` so an embedder can bring its own model call. Whatever
produces the answer, it is validated the same way.

## Running it with a model

```sh
pnpm add @ai-sdk/anthropic            # or the provider you use
export ANTHROPIC_API_KEY=...
export AUTOREMEDIATOR_MODEL=anthropic:claude-sonnet-5-5
autoremediator policy compile "don't touch left-pad"
```

The automated tests use scripted model outputs (and the AI SDK's mock model to exercise the
structured-output call), not a live model, so how well a particular model follows the instructions
(quoting your words exactly, naming the right keys) is not covered by them. When a model does not,
the proposal is refused, not guessed at.
