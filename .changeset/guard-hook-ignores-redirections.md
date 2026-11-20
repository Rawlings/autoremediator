---
"autoremediator": patch
---

The install guard no longer mistakes shell redirections for packages. A command such as
`npm install --package-lock-only 2>&1`, `npm i chalk > install.log` or `pnpm add zod &>/dev/null`
used to be blocked as "not a valid npm package name"; redirections (`2>&1`, `>`, `>>`, `<`, `&>`)
and a trailing `&` are now ignored when reading the packages to check.
