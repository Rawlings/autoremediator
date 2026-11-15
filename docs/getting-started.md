# Getting started

Autoremediator does agentic remediation for the npm dependencies of a Node.js project. You give it
an advisory id or scanner output; it plans the smallest safe fix, applies it, repairs the code an
upgrade breaks (when you configure a model), verifies the result, and reports what it did and what
it could not fix.

## Install

It needs Node.js 26 or later and a project with a `package.json`. npm, pnpm, Yarn, Bun and Deno projects
are supported; the package manager is detected from the lockfile.

```bash
npx autoremediator --help          # run without installing
npm install --global autoremediator
```

## Preview a fix

Pass a CVE or GHSA id. `--dry-run` plans the change and writes nothing.

```bash
autoremediator CVE-2021-23337 --dry-run
```

The report lists each affected package on one line (`✔` fixed, `○` would fix in a dry run, `✘` not
fixed, with the reason), followed by counters and the path of the evidence file.

## Apply it

```bash
autoremediator CVE-2021-23337 --run-tests
```

Each change is installed and, with `--run-tests`, tested. A change that fails is rolled back and
reported as unresolved. Add `--typecheck` to run the type checker too.

## Fix everything a scanner reports

```bash
autoremediator --audit                    # run the package manager's own audit
autoremediator ./npm-audit.json           # or read a saved report
```

See [Scanners and inputs](guides/scanners.md) for supported formats.

## Next steps

- Understand what it will and will not change: [How it works](how-it-works.md).
- Restrict it to what you are comfortable with: [Policy file](reference/policy-file.md).
- Run it unattended: [Automation and CI](guides/automation.md),
  [GitHub Action](integrations/github-action.md) or [GitHub App](integrations/github-app.md).
- Review the [safety guarantees](safety.md) before enabling it on a shared repository.
