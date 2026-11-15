<h1 align="center">Autoremediator</h1>

<p align="center"><strong>Agentic remediation for Node.js dependencies.</strong><br>From vulnerability alert to a verified fix, without the manual work in between.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/autoremediator"><img alt="npm version" src="https://img.shields.io/npm/v/autoremediator?color=cb3837&logo=npm"></a>
  <a href="https://github.com/Rawlings/autoremediator/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Rawlings/autoremediator/ci.yml?branch=master&logo=github&label=CI"></a>
  <a href="https://www.npmjs.com/package/autoremediator"><img alt="node" src="https://img.shields.io/node/v/autoremediator?logo=nodedotjs&logoColor=white"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/autoremediator"></a>
</p>

<p align="center">
  <a href="#try-it-on-your-project">Try it</a> ·
  <a href="docs/getting-started.md">Getting started</a> ·
  <a href="docs/how-it-works.md">How it works</a> ·
  <a href="docs/integrations/github-action.md">GitHub Action</a> ·
  <a href="docs/README.md">Docs</a>
</p>

Scanners tell you what is vulnerable. Update bots open a pull request for a version bump. The work
in between is still yours: which version really fixes it, whether the package is buried three levels
deep, and what to do when the upgrade breaks your build or no fix exists.

Autoremediator closes that gap. It plans the smallest safe fix, applies it, and checks the result
against your own tests. When an upgrade breaks your code, an agent repairs the code, and an
independent verifier decides whether the change is kept. Anything that can't be fixed safely is left
alone and explained.

## How agentic remediation works

1. **Plan.** It reads your audit, a CVE or GHSA id, or a SARIF report, weighs exploit signals and
   your deadlines, and works out the smallest change that actually fixes each package.
2. **Fix.** It applies the change the way your package manager expects: an upgrade, or a pinned
   override when the vulnerable package is buried in the tree.
3. **Repair.** If the fix breaks your build or tests, an agent works in an isolated copy of your
   project and adjusts your source to match the new version. Your working tree isn't touched.
4. **Verify.** Install, tests, type check and an optional proof of fix run independently of the
   agent. Only a change that passes is kept. Everything else is rolled back.

When there is no fixed version at all, it can draft a patch for review. That, and the repair step,
need a model you choose and pay for. Everything else works without one.

## Try it on your project

You need Node.js 26 or later and a project with a `package.json`. There is nothing to install.

```bash
npx autoremediator --audit --dry-run     # see the plan, change nothing
npx autoremediator --audit --run-tests   # apply it, test it, roll back failures
```

You get one line per package showing what was fixed and what wasn't, plus an evidence file recording
what was checked and decided. Already have a specific advisory in mind? Pass its CVE or GHSA id
instead of `--audit`.

## What happens to each vulnerable package

| Situation                       | What Autoremediator does                                              |
| ------------------------------- | --------------------------------------------------------------------- |
| A fixed version exists          | Upgrades to the smallest safe version, so the change stays small      |
| The package is a transitive dep | Pins the fix with your package manager's own override mechanism       |
| The upgrade breaks your code    | Has an agent repair your source in isolation, then verifies the result |
| No fixed version exists         | Drafts a reviewable patch file, if you have configured a model        |
| It can't be fixed safely        | Changes nothing and reports the exact reason                          |

Works with npm, pnpm, Yarn, Bun and Deno projects, detected from your lockfile.

## An agent you can give the keys to

Autonomy is only useful if you can trust where it stops.

- **Isolated, then verified.** The agent works in a separate checkout with a short list of tools. It
  can't touch your lockfile, CI config, policy or credentials, and its own opinion that it
  succeeded counts for nothing.
- **You set the limits.** A [policy file](docs/reference/policy-file.md) decides what may change,
  what needs approval, and what escalates. A repository earns more freedom from its own verified
  track record.
- **Exploit-aware.** CISA KEV and EPSS signals and your SLA windows decide what is urgent.
- **No silent skips.** Every unfixed finding comes back with a reason a machine can read.
- **Your models, your infrastructure.** It runs on your machine or CI with your own keys. The code
  is MIT licensed, and `--offline` works from a local advisory snapshot.
- **A paper trail.** Each run records what was checked, what changed and why.

## Bring it to where you work

Start with the command line, then move it where it earns its keep.

|                                                                       | Good for                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **[Coding agents](docs/integrations/coding-agents.md)**               | Let Claude Code, Cursor, Copilot, Codex or Gemini CLI do the repair with Autoremediator's tools and verifier |
| **[GitHub Action](docs/integrations/github-action.md)**               | A nightly pull request that fixes what audit finds                             |
| **[GitHub App](docs/integrations/github-app.md)**                     | Every repository you install it on                                             |
| **[VS Code](packages/vscode-extension/README.md)**                    | Findings and one-click fixes inside your manifest                              |
| **[Other CI](docs/integrations/other-ci.md)**                         | GitLab, Bitbucket Pipelines, Azure DevOps, Docker, Dagger                      |
| **[SDK](docs/reference/sdk.md), [MCP](docs/integrations/mcp-server.md), [HTTP](docs/integrations/http-server.md), [A2A](docs/integrations/a2a.md)** | Call it from your own code, agents or internal services |

<details>
<summary><strong>More than fixing a CVE</strong></summary>

<br>

- [**Guard**](docs/guides/guard.md): check a package before you or an agent installs it
- [**Upgrade impact**](docs/guides/upgrade-impact.md): see what an upgrade would break in your own code before you make it
- [**Runtime reachability**](docs/guides/runtime-reachability.md): record which dependencies your tests actually load and call
- [**Incident response**](docs/guides/incident-response.md): find your exposure when a package is compromised
- [**Evidence pack**](docs/guides/evidence-pack.md): SBOM, VEX and CRA report drafts from local data
- [**Dependency diet**](docs/guides/dependency-diet.md): unused, replaceable and duplicate dependencies
- [**Freshness**](docs/guides/freshness.md): keep dependencies current in small verified steps
- [**Silent-fix radar**](docs/guides/silent-fix-radar.md): spot security fixes that have no advisory yet
- [**Exploit-proof evidence**](docs/guides/proof-of-fix-generation.md): a model writes a reproduction, the harness proves it
- [**Lockfile bisect**](docs/guides/bisect.md): find which update broke a command
- [**Policy in plain language**](docs/guides/policy-in-plain-language.md): compile rules into a reviewable policy diff

</details>

> [!NOTE]
> Autoremediator is pre-1.0 and changes your dependency files. Start with a dry run, keep CI and
> branch protection in place, and read [Safety](docs/safety.md) before pointing it at a shared
> repository. Rough edges are expected; [issues](https://github.com/Rawlings/autoremediator/issues)
> are welcome.

## Learn more

[Getting started](docs/getting-started.md) · [How it works](docs/how-it-works.md) ·
[CLI](docs/reference/cli.md) · [All documentation](docs/README.md) ·
[Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
