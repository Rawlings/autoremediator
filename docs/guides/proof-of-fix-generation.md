# Exploit-proof evidence: a reproduction an agent writes and a harness proves

`--proof-of-fix` asks for a reproduction script: it must fail before a fix and pass after. Until now
a person wrote it. `autoremediator prove` has an agent write it, and keeps it only if a
deterministic harness proves it. An agent proposes; the harness disposes; git remembers.

```bash
export AUTOREMEDIATOR_MODEL=anthropic:claude-sonnet-5-5
autoremediator prove GHSA-35jh-r3h4-6jhm --package lodash
```

```text
GHSA-35jh-r3h4-6jhm: lodash 4.17.20 (vulnerable) vs 4.17.21 (fixed)
  try 1: rejected (vulnerable) The script exits 0 on the vulnerable version, so it does not detect the vulnerability. ...
  try 2: accepted (confirmed) Fails on lodash@4.17.20 and passes on lodash@4.17.21, 2 times each.
Kept. Script: patches/lodash+4.17.20.test.cjs
Evidence: patches/lodash+4.17.20.proof.json
```

It needs a model (`--model <provider>:<model-id>` or `AUTOREMEDIATOR_MODEL`, the same as the
[patch fallback](patch-generation.md)) and the network. With no model it stops before fetching or
writing anything and says so. Exit code `0` means a script was kept, `1` means none was proven.

## What is kept, and what that proves

A script is kept only if, in a sandbox, all of this holds, twice in a row:

1. On the **vulnerable** version it fails the way the existing
   [proof-of-fix check](../how-it-works.md) expects: exit code `1` with an assertion error or an
   `EXPLOIT_REPRODUCED:` line. A crash (a `TypeError`, a missing module, a bad exit code) does not
   count.
2. On the **fixed** version it exits `0`.

Both versions are installed from the registry into separate temporary directories. The package under
test is downloaded by autoremediator and checked against the integrity digest the registry
advertises (a tarball without a digest is refused), then installed from exactly that file. Its own
dependencies, if it has any, are resolved by npm from the same registry with install scripts
disabled; npm checks those, autoremediator does not check them again. Nothing is installed in your
project.

**What the harness does not prove.** It proves the script tells the two versions apart through the
package's public API, repeatably. It cannot prove that the difference it finds is the advisory's
vulnerability: a script could tell the versions apart by something unrelated to the flaw. Read the
script before you rely on it. It is short, it is committed to your repository, and the evidence
record says this in its `claim` field. To make the obvious shortcuts harder, a script that reads the
version, reads `package.json`, loads anything but the package and a few Node built-ins, or reaches for
the network, the environment or processes is refused before it runs.

## How the agent works

The agent is an `ai@7` `generateText` loop with the model from `--model`, in the style of the
[repair agent](plan-and-apply.md). It is given the advisory's summary, details, CWE ids and
references (from OSV, or from `--advisory-text`), the two versions, and the exports the fix changed
(a heuristic ranking from a diff of the two versions, the same one
[`symbols`](upgrade-impact.md) reports). Its tools are read-only: list and read the source of either
version, `tryScript`, and `giveUp`. `tryScript` hands a candidate to the harness and returns the harness's verdict, so the
agent can correct a rejected script; it has `--max-trials` tries (default 4, at most 10). Advisory
text, package source and sandbox output are all data to the agent, never instructions.

The agent never decides that a script is good, and nothing it says about a script is read. The only
way a script is accepted is the harness run described above. A model that gives up, runs out of tries
or fails produces no script and a reason.

## The sandbox

The script is untrusted code. It runs with:

| Control | How | Verified how |
| --- | --- | --- |
| No network (sockets, `fetch`, `http`, DNS, UDP) | Node permission model (`--permission`, no `--allow-net`) | A self-test runs on the first use, in this process, and tries each of these from inside; a local listener must see no connection |
| No child processes, worker threads, native addons | permission model | self-test |
| Reads only its own temporary directory; no writes anywhere | permission model (`--allow-fs-read=<dir>`, no `--allow-fs-write`) | self-test (a file beside the directory, `/etc/hosts` and the parent directory are all refused) |
| Empty environment: only `NODE_ENV`, `TZ`, `LANG` | the process is started with exactly that environment | self-test lists the variable names |
| No signalling of other processes (the model could otherwise kill the caller or, with `-1`, every process you own) | a preload refuses `process.kill` for any pid but its own; the permission model does not cover signals | self-test |
| Wall-clock timeout (`--timeout-ms`, default 10 s), output cap (256 KiB), V8 heap cap (256 MiB) | the process runs in its own process group, which is killed on timeout, on exceeding the cap, and when it ends | tests with a script that loops forever and one that floods its output |

If the self-test finds that this Node.js does not enforce all of this, `prove` stops with an error
rather than run the script (Node 26 or newer is required, which is the package's minimum anyway).
The self-test result is recorded in the evidence (`sandbox.denied`).

**What the sandbox does not limit**, stated plainly because the record repeats it:

- CPU time: only the wall-clock timeout bounds it.
- Memory outside the V8 heap, such as large buffers.
- A flaw in Node.js itself. Node documents the permission model as a guard against misbehaving code,
  not a boundary against a determined attacker. If you run `prove` on advisory text or packages you do
  not control, run it in a container.
- Windows: the sandbox needs process groups and is not available there.

**A kept script runs in the same sandbox later.** `--proof-of-fix` and `--require-proof-of-fix` run
the script (yours, or one `prove` kept) under the same permission model: no network, no child
processes, no writes, an empty environment, reads limited to the project. The sandbox is self-tested
once per process; if it does not hold on this machine the proof phase is a harness failure, never a
pass. The script must be inside the project. On Windows there is no sandbox, and the script runs with
plain `node` in your project, so review it there. Reading is still allowed inside the project, and
the output goes into the run's evidence, so a script can print what it reads: review what you keep.

## Where things are written

Under the patches directory (`--patches-dir`, default `./patches`), which is where the proof-of-fix
check already looks for `<package>+<version>.test.cjs`:

| File | What |
| --- | --- |
| `<package>+<vulnerable-version>.test.cjs` | The script. With `--proof-of-fix` the remediation flow finds it by this name and runs it before the change (it must fail) and after (it must pass) |
| `<package>+<vulnerable-version>.proof.json` | The evidence record |
| `<package>+<vulnerable-version>.proof.json.sig` | With `--signing-key`: a detached signature |

(Scoped packages use `+` for the slash, as for patch files: `scope+name+1.2.3`.) A script already at
that path that this command did not write is never replaced unless you pass `--overwrite`; the MCP
tool and HTTP route have no such option. These files are meant to be committed.

The evidence record is plain JSON: the advisory id, the package, both versions, the script's path and
SHA-256, the result of the vulnerable run and the fixed run (exit code, signal, duration, the tail of
the output with paths removed), how many times the pair held (`confirmedRuns`), the tarball URLs and
integrity digests of both versions, the sandbox self-test result and limits, the Node.js version, a
timestamp, the model that proposed the script (`null` when it was supplied), the agent id and how
many candidates were tried.

## Signing

```bash
openssl genpkey -algorithm ed25519 -out proof-key.pem
openssl pkey -in proof-key.pem -pubout -out proof-key.pub.pem
autoremediator prove GHSA-35jh-r3h4-6jhm --package lodash --signing-key proof-key.pem
```

The signature is [DSSE](https://github.com/secure-systems-lab/dsse), detached: Ed25519 over the
pre-authentication encoding of the payload type `application/vnd.autoremediator.proof-of-fix+json`
and the exact bytes of the `.proof.json` file. The `.sig` file holds `{payloadType, algorithm, keyid,
sig}`; `keyid` is `sha256:` and the digest of the public key's SPKI encoding. There is no key service
and no certificate: whoever has the public key can check that the record was signed by the matching
private key and has not changed since, and nothing says who the key belongs to. Keep the private key
out of the repository.

To check one, use the SDK:

```ts
import { verifyProofEvidence } from "autoremediator";
verifyProofEvidence("patches/lodash+4.17.20.proof.json", "proof-key.pub.pem");
// { valid: true, keyid: "sha256:..." }
```

## VEX

When evidence exists in the patches directory for the advisory and package of a report, the
CycloneDX VEX output (`--output-format cyclonedx-vex`, SDK `toCycloneDxVex` with
`proofEvidence: proofEvidenceRefs(cwd)`) cites it: the vulnerability gains a sentence in
`analysis.detail` and `autoremediator:proof-of-fix:evidence` and `...:script-sha256` properties.
With no evidence the output is exactly what it was. Evidence whose script has changed since (its
SHA-256 no longer matches) is not cited.

## Options

| CLI | SDK / MCP / HTTP | |
| --- | --- | --- |
| `<advisory>` | `cveId` | CVE, GHSA or OSV id. Any label with `--advisory-text` |
| `--package` | `package` | Optional when the advisory affects exactly one package |
| `--vulnerable-version` | `vulnerableVersion` | Default: newest stable vulnerable version below the fix |
| `--fixed-version` | `fixedVersion` | Default: the advisory's first patched version |
| `--advisory-text` | `advisoryText` | Your own description, instead of or with OSV's |
| `--model` | `model` | `<provider>:<model-id>`, default `AUTOREMEDIATOR_MODEL` |
| `--patches-dir` | `patchesDir` | Default `./patches` (path-guarded for MCP and HTTP) |
| `--signing-key` | `signingKeyPath` | Ed25519 PEM private key (path-guarded for MCP and HTTP) |
| `--max-trials` | `maxTrials` | 1-10, default 4 |
| `--timeout-ms` | `timeoutMs` | One sandboxed run, 1000-60000, default 10000 |
| `--overwrite` | SDK `overwrite` | CLI and SDK only |
| | SDK `agent` | Your own `ReproductionAgent`, instead of one built from `model`; SDK only |

The MCP tool is `generateProofOfFix`, the HTTP route is `POST /proof-of-fix/generate` (operator role),
and the SDK function is `generateProofOfFix(cveId, options, deps?)`.

## When it says no

Not every vulnerability can be reproduced in a small script through a public API: a flaw in a server,
in behaviour that needs a particular file or environment, or in an export that is not reachable the
way the advisory assumes. A rejected run reports each try and why it was rejected, or the agent's own
reason for giving up. That is a result, not a failure. The harness is deliberately strict and does not
meet a script halfway: a script that passes on both versions detects nothing, and one that fails on
both does not distinguish them.

The version choice follows the advisory. If its vulnerable range names versions that are not actually
vulnerable, no honest script can fail on them and the run is rejected. (Trying lodash 4.17.18 against
4.17.19 for the 2020 prototype-pollution advisory GHSA-p6mc-m468-83gw, a scripted reproduction of
`_.set` pollution exited 0 on the "vulnerable" version and was rejected for that reason.)

## Limits

- Needs a model and the network; there is no offline mode.
- npm registries only; credentials for a private registry are not passed to the install of the
  package's own dependencies, so a package whose dependencies live behind credentials cannot be
  proven.
- The package's own dependencies are resolved to whatever the registry offers now, not to what your
  project locks.
- CommonJS reproductions, one file, written against the package's public API.
