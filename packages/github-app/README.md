# @autoremediator/github-app

A GitHub App server that remediates vulnerable npm dependencies in the repositories it is installed
on, and can open pull requests with the fixes.

- Reacts to `check_suite`, `push` (default branch) and `workflow_dispatch` events.
- Queues work with retries, and verifies webhook signatures.
- Repositories configure it with `.github/autoremediator.yml`. Every repository starts in dry-run
  mode.
- Optionally repairs failing checks on its own pull requests.

Setup, repository configuration and the full list of settings are in the
[GitHub App guide](https://github.com/Diffra/autoremediator/blob/master/docs/integrations/github-app.md).

## License

MIT
