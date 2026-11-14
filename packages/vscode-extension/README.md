# Autoremediator for VS Code

Shows known vulnerabilities in your Node.js dependencies where you edit them, and fixes them with
[Autoremediator](https://github.com/Rawlings/autoremediator#readme).

## What it does

- **Diagnostics** on `package.json` for every vulnerable dependency, with the advisory, severity,
  CISA KEV status, EPSS score and the safe version when one exists.
- **Quick fix** that runs Autoremediator for that CVE.
- **CodeLens** above `dependencies` summarizing findings and how many are fixable.
- **Commands** (Command Palette):
  - `Autoremediator: Scan workspace for CVEs`
  - `Autoremediator: Scan git delta against HEAD`: only dependencies changed since `HEAD`
  - `Autoremediator: Check package AST reachability`: is the package imported by your source
  - `Autoremediator: Preview patch artifact`: view a generated `.patch` before applying it

Scans run `npm`, `pnpm` or `yarn audit` and feed the result to the Autoremediator CLI in dry-run
mode. Nothing changes until you apply a fix.

## Requirements

Node.js 26 or later. The extension uses the `autoremediator` CLI from the workspace's
`node_modules`, or downloads it with `npx`.

## More

Documentation, including the CLI and policy file, is in the
[main repository](https://github.com/Rawlings/autoremediator/blob/master/docs/README.md).

## License

MIT
