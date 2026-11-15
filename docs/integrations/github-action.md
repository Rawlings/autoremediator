# GitHub Action

Runs Autoremediator in a workflow and can open a pull request with the result. Pin a release tag or
a commit SHA.

```yaml
permissions:
  contents: write
  pull-requests: write

steps:
  - uses: actions/checkout@v5
  - uses: rawlings/autoremediator@v0.22.0
    with:
      audit: true
      run-tests: true
      create-pull-request: true
    env:
      GH_TOKEN: ${{ github.token }}
```

## Choosing what to fix

Set exactly one of:

| Input | Remediates |
| ----- | ---------- |
| `audit: true` | Whatever the package manager's audit reports |
| `scan-file: <path>` | A saved scanner report (`format`: `auto`, `npm-audit`, `yarn-audit`, `sarif`) |
| `cve-id: <id>` | One CVE or GHSA id |
| `update-outdated: true` | Every outdated dependency (`include-transitive` to cover transitive ones) |

## Other inputs

| Input | Default | Meaning |
| ----- | ------- | ------- |
| `dry-run` | `false` | Plan only. No pull request is opened |
| `run-tests` | `false` | Run the project's tests after each change |
| `ci` | `false` | Fail the step when any remediation failed |
| `cwd` | `.` | Project directory |
| `package-manager` | detected | `npm`, `pnpm`, `yarn`, `bun` or `deno` |
| `policy` | `.github/autoremediator.yml` | [Policy file](../reference/policy-file.md) |
| `containment-mode`, `simulation-mode` | `false` | See [How it works](../how-it-works.md#outcomes) |
| `offline`, `intelligence-snapshot` | `false` | [Offline use](../guides/offline.md) |
| `model` | none | [Patch fallback](../guides/patch-generation.md). Needs that provider's `@ai-sdk/*` package and API key in the job environment |
| `summary-file` | none | Write a machine-readable summary |
| `node-version` | `26` | Node.js version. Must be 26 or later |
| `package` | empty | What to install instead of the `autoremediator` version that ships with the action: an npm spec or a tarball from `pnpm pack`. For testing unreleased code |
| `token` | `github.token` | Token used for the pull request |

## Pull requests

`create-pull-request: true` opens a pull request unless `dry-run` is set.

| Input | Meaning |
| ----- | ------- |
| `pull-request-branch` | Branch prefix. The branch is `<prefix>/<cve-ids>-<suffix>`; the default prefix is `autoremediator` |
| `pull-request-title` | Prefix for the title and commit message |

## Outputs

| Output | Meaning |
| ------ | ------- |
| `pull-request-url` | URL of the pull request, if one was created |
| `summary-file` | Path of the summary file, if requested |

## Ready-made workflows

- [`reusable-remediate-from-audit.yml`](../../.github/workflows/reusable-remediate-from-audit.yml):
  call it from your own workflow for a nightly audit and pull request.
- [`.github/workflow-templates`](../../.github/workflow-templates): copy-and-edit templates for a
  nightly pull request, an enforcement gate and a SARIF upload.

See [Automation and CI](../guides/automation.md) for exit codes and report formats.
