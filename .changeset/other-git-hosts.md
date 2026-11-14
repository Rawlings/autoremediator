---
"autoremediator": minor
---

Support non-GitHub git hosts and CI systems.

- Change requests: `provider` (`--change-request-provider`) now accepts `bitbucket` and `azure-devops` in addition to `github` and `gitlab`. Bitbucket Cloud and Azure DevOps Services pull requests are created through their REST APIs; GitLab merge requests use the REST API when a token is available and fall back to `glab` otherwise.
- Fix GitLab HTTPS push authentication: the branch push now authenticates as `oauth2:<token>` instead of the GitHub-style `x-access-token`. Bitbucket uses `x-token-auth`, and Azure DevOps uses a bearer header for `System.AccessToken` or basic auth for PATs.
- Each provider reads its own token variable (`GITLAB_TOKEN`, `BITBUCKET_TOKEN`, `AZURE_DEVOPS_EXT_PAT` / `SYSTEM_ACCESSTOKEN`). A GitHub token is no longer sent to non-GitHub remotes.
- Non-GitHub providers accept `group/subgroup/project` (GitLab) and `org/project/repo` (Azure DevOps) in `changeRequest.repository`, detect them from the remote, and no longer commit with the `github-actions[bot]` identity. An unknown provider is now rejected instead of being treated as GitLab.
- Add ready-made pipeline templates for GitLab CI, Bitbucket Pipelines and Azure Pipelines under `templates/`, a Dagger module under `dagger/`, and the guide `docs/integrations/other-ci.md`.
- Image: the CLI Docker image now includes `git`, which change requests need.
