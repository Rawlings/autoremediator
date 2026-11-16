# Other CI systems

Autoremediator is a CLI, so it runs anywhere Node.js 26 and git do. This page covers ready-made
templates for GitLab CI, Bitbucket Pipelines and Azure Pipelines, the Docker image, and a Dagger
module. For GitHub see [GitHub Action](github-action.md).

Every template runs the same command and, when asked, opens a change request on the host:

```sh
npx -y autoremediator@^0.22.0 --audit --ci --output-format json \
  --create-change-request --change-request-provider <gitlab|bitbucket|azure-devops>
```

`--ci` exits non-zero when a remediation failed. The JSON report is saved as a pipeline artifact.

## How change requests authenticate

`--create-change-request` pushes a branch over HTTPS and then calls the host's API. The token comes
from the host's own variable; a GitHub token is never sent to another host.

| Provider | Opens | Token variable | Push as | API |
| -------- | ----- | -------------- | ------- | --- |
| `gitlab` | Merge request | `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN` | `oauth2:<token>` | `POST /api/v4/projects/:path/merge_requests`. Falls back to `glab` when there is no token |
| `bitbucket` | Pull request | `BITBUCKET_TOKEN` | `x-token-auth:<token>` | Bitbucket Cloud `2.0/repositories/{workspace}/{repo}/pullrequests` |
| `azure-devops` | Pull request | `AZURE_DEVOPS_EXT_PAT`, `AZURE_DEVOPS_TOKEN`, `SYSTEM_ACCESSTOKEN` | Bearer for `System.AccessToken`, basic for a PAT | Azure DevOps Services `_apis/git/repositories/{repo}/pullrequests` |

The repository is read from `remote.origin.url`. Override it with `--change-request-repository`:
`group/subgroup/project` for GitLab, `workspace/repo` for Bitbucket, `organization/project/repo` for
Azure DevOps. Bitbucket and Azure DevOps require a token and refuse before pushing without one.
Bitbucket Data Center / Server and Azure DevOps Server are not supported.

Commits use the identity `autoremediator[bot]` with a `noreply.invalid` address. If your host
enforces committer checks (for example a GitLab push rule), allow that address or run the job as a
bot user.

## GitLab CI

[`integrations/ci-templates/gitlab/autoremediator.yml`](../../integrations/ci-templates/gitlab/autoremediator.yml) is a template
with `spec: inputs:`. Include it with GitLab 16.11 or later:

```yaml
include:
  - remote: https://raw.githubusercontent.com/rawlings/autoremediator/v0.22.0/templates/gitlab/autoremediator.yml
    inputs:
      version: "^0.22.0"
      base_branch: main
```

Then add a pipeline schedule (CI/CD > Schedules). By default the job runs on schedules and manual
web pipelines only, so the `autoremediator/*` branches it pushes do not trigger it again.

Requirements:

- A masked CI/CD variable `GITLAB_TOKEN`: a project access token with the **Developer** role and the
  `api` and `write_repository` scopes. The job token cannot open merge requests.
- The target branch must allow pushes of new branches by that token's user.

| Input | Default | Meaning |
| ----- | ------- | ------- |
| `job_name`, `stage` | `autoremediator`, `test` | Job name and stage |
| `image` | `node:26` | Node.js 26+ image. Git is installed on Debian images that lack it |
| `version` | `^0.22.0` | npm range that `npx` runs |
| `cwd` | `.` | Project directory |
| `base_branch` | `$CI_DEFAULT_BRANCH` | Merge request target |
| `run_tests` | `false` | Run the project's tests after each change |
| `create_merge_request` | `true` | `false` reports without pushing |
| `policy` | none | [Policy file](../reference/policy-file.md) path |
| `extra_args` | none | Extra CLI flags |
| `allow_failure` | `false` | Keep the pipeline green when remediation fails |
| `rules` | schedule and web | GitLab `rules:` for the job |

The template points `origin` at the clean project URL so the runner's embedded job token does not
conflict with `GITLAB_TOKEN`. Self-managed instances work: the API URL is taken from
`CI_API_V4_URL`, or from the remote host.

## Bitbucket Pipelines

[`integrations/ci-templates/bitbucket/bitbucket-pipelines.yml`](../../integrations/ci-templates/bitbucket/bitbucket-pipelines.yml)
defines a `custom` pipeline named `autoremediator`. Copy its step into your
`bitbucket-pipelines.yml`, then schedule it (Repository settings > Pipelines > Schedules) or run it
from the Pipelines page.

Requirements:

- A secured repository variable `BITBUCKET_TOKEN`: a repository or workspace access token with
  **Repositories: Write** and **Pull requests: Write**.
- Run it on the branch the pull request should target; the step uses `$BITBUCKET_BRANCH`.

Pipelines clones through a local proxy, so the step points `origin` at `bitbucket.org` for the push.
This is a pipeline snippet, not a published Bitbucket pipe.

## Azure DevOps

[`integrations/ci-templates/azure-devops/autoremediator.yml`](../../integrations/ci-templates/azure-devops/autoremediator.yml) is a
step template. [`azure-pipelines.example.yml`](../../integrations/ci-templates/azure-devops/azure-pipelines.example.yml)
shows a nightly run that pulls the template from a `resources.repositories` entry.

```yaml
steps:
  - checkout: self
    persistCredentials: false
  - template: integrations/ci-templates/azure-devops/autoremediator.yml@autoremediator
    parameters:
      baseBranch: main
```

Requirements:

- The build service identity (`<Project> Build Service`) needs **Contribute**, **Create branch** and
  **Contribute to pull requests** on the repository. The template passes `$(System.AccessToken)`.
  A PAT in `AZURE_DEVOPS_EXT_PAT` works instead.
- Keep `persistCredentials: false`. A persisted checkout header would be sent alongside the push
  header.
- Azure DevOps Services only (`dev.azure.com`).

| Parameter | Default | Meaning |
| --------- | ------- | ------- |
| `version` | `^0.22.0` | npm range that `npx` runs |
| `nodeVersion` | `26.x` | Passed to `NodeTool@0` |
| `baseBranch` | `main` | Pull request target |
| `createPullRequest` | `true` | `false` reports without pushing |
| `runTests`, `policy`, `extraArgs` | off, none, none | As for the GitLab inputs |
| `continueOnError` | `false` | Keep the pipeline green when remediation fails |

## Docker

The [`Dockerfile`](../../Dockerfile) builds the CLI from the checkout it sits in: non-root user,
entrypoint `autoremediator`, git included. Released images are published to
`ghcr.io/rawlings/autoremediator`.

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/workdir" \
  ghcr.io/rawlings/autoremediator:0.22.0 --audit --output-format json
```

The image carries npm but not pnpm, yarn or bun. Projects that use those need an image that adds
them, or run the CLI through `npx` on your own image as the templates above do. For change requests,
pass the host token as `-e GITLAB_TOKEN` (or the matching variable).

## Dagger

[`dagger/`](../../integrations/dagger) is a Dagger module with TypeScript functions that run the CLI in a
`node:26` container:

```sh
dagger call -m ./dagger remediate --source . export --path .   # apply the fixes locally
dagger call -m ./dagger report --source . contents             # print the JSON report
dagger call -m ./dagger container --source . terminal          # shell with the CLI installed
```

`remediate` takes `--version`, `--node-version` and repeated `--args` for extra CLI flags (for
example `--args=--run-tests`). It never pushes or opens a change request; review the exported diff
and commit it yourself. `.git` and `node_modules` are not sent to the container.

## Unverified here

These integrations are covered by unit and real-git tests of the core push and API code, and the
YAML parses, but the pipelines themselves have not been run on GitLab, Bitbucket, Azure DevOps or a
Dagger engine. Try them on a throwaway repository first, and report mismatches as issues.
