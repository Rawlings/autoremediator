---
"@autoremediator/github-app": patch
---

Fixes for the bot PR doctor, pull request healing and comment commands:

- The bot PR doctor and pull request healing only edit files the pull request itself changed (listed
  with the pull request files API), and a "did you mean" rename only to an identifier already in
  that file. CI output can be forged by anything running in the job, so it can no longer pick which
  repository file is edited; a Dependabot or Renovate pull request, which changes manifests and
  lockfiles, gets a diagnosis comment instead.
- A comment command is answered once. A failed run, a failed checkout or clone, or an invalid `cwd`
  now ends the job as `partial` after one generic failure comment (no URLs or tokens) instead of
  throwing, so the queue no longer runs the command, and posts the reply, up to three times.
- A `fix` in a repository that defaults to `dryRun` says in its reply that it opened a pull request
  anyway because it was asked to. Behaviour is unchanged.
- People without write access get one reply per issue or pull request (tracked in the state store;
  none without a state store) instead of one per comment.
- `/autoremediator rollback` only echoes run ids from a description or commits written by a bot
  account other than Dependabot and Renovate, so a person's text cannot supply them.
