---
"autoremediator": minor
---

VEX in the package, and the maintainer autopilot.

- Convention: a package ships its own reachability verdicts as an OpenVEX v0.2.0 document in its
  tarball, declared by `package.json#vex` (a relative path, or `true` for `vex.openvex.json`).
- Consumer: remediation, planning and scans read the documents of installed packages (size-capped,
  strictly validated, confined to the package, products must name the exact installed `name@version`,
  prototype-pollution-shaped keys rejected) and attach accepted `not_affected` verdicts as
  `maintainerVex` evidence on each result and in the CycloneDX VEX output
  (`autoremediator:maintainer-vex` property). A package declaring itself not affected by an advisory
  about itself is rejected. New policy key `trustMaintainerVex` (default `false`, policy file only)
  turns accepted verdicts into suppressions (`suppressedBy.source: "maintainer-vex"`); without it
  nothing changes.
- Producer: `autoremediator maintain [--yes] [--assert-not-affected]` / `maintain()` assesses
  advisories in a package's dependencies against its own code (static reachability, optional
  `--trace-file`) and prepares, never publishes or pushes, a bump plan, a changeset and the OpenVEX
  statement wired into `package.json` (`vex`, `files`). `not_affected` is written only when the scan
  finds the dependency unreachable and `--assert-not-affected` is given. Shows a diff; writes only with
  `--yes`.
- `autoremediator vex show` / `readMaintainerVex` (also an MCP tool and `POST /maintainer-vex`) lists
  what installed packages ship and why a declared document was rejected.
- New catalog operations `readMaintainerVex` (read-only, every surface) and `maintain` (CLI and SDK
  only; deliberately not an MCP tool or HTTP route, because it writes files).
- New guide: `docs/guides/maintainer-vex.md`, including the convention as a proposal.
