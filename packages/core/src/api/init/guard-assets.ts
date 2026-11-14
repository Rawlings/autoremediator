/**
 * What `init --guard` writes for each place a package can be added from: the hook entries for Cursor
 * and GitHub Copilot, and a pnpmfile. The Claude Code hook command lives in `assets.ts`.
 */
import { PACKAGE_VERSION } from "../../version.js";
import { DOCS_URL } from "./assets.js";

export const CURSOR_HOOKS_PATH = ".cursor/hooks.json";
export const COPILOT_HOOKS_PATH = ".github/hooks/autoremediator-guard.json";
export const PNPMFILE_PATH = ".pnpmfile.cjs";
/** Marker in the pnpmfile: a file with it is ours to refresh, any other is the user's. */
export const PNPMFILE_MARKER = 'Added by "autoremediator init --guard"';

const PREFILTER = "*npm*|*pnpm*|*yarn*|*bun*";

function hookCommand(range: string, host: "cursor" | "copilot"): string {
  return `npx -y -p autoremediator@${range} autoremediator guard-hook --host ${host}`;
}

/**
 * Cursor `.cursor/hooks.json` entry for `beforeShellExecution`. Cursor matches `matcher` against the
 * full command string, so only install-looking commands start the hook at all.
 * Source: https://cursor.com/docs/agent/hooks
 */
export function cursorGuardHookEntry(range: string = `^${PACKAGE_VERSION}`): Record<string, unknown> {
  return { command: hookCommand(range, "cursor"), matcher: "npm|pnpm|yarn|bun", timeout: 60 };
}

/**
 * GitHub Copilot hook entry for `preToolUse` (`.github/hooks/*.json`, read by Copilot CLI, the cloud
 * agent and the Copilot harness in VS Code). A failing preToolUse command denies the tool call, so the
 * commands end so that they exit 0 even when the guard cannot run (no network for npx): the command
 * then goes through, as it does for Claude Code and Cursor.
 * Source: https://docs.github.com/en/copilot/reference/hooks-reference
 */
export function copilotGuardHookEntry(range: string = `^${PACKAGE_VERSION}`): Record<string, unknown> {
  const base = hookCommand(range, "copilot");
  return {
    type: "command",
    bash: `in=$(cat); case "$in" in ${PREFILTER}) printf '%s' "$in" | ${base} || true;; esac`,
    powershell: `${base}; exit 0`,
    matcher: "bash|powershell",
    timeoutSec: 60,
  };
}

/**
 * A `.pnpmfile.cjs` that runs `guard` on the dependencies an install is about to add.
 *
 * What was observed running pnpm 12 with logging hooks, and what this relies on:
 * - `readPackage` is called with the project's manifest as pnpm is about to resolve it. For
 *   `pnpm add x` that manifest already lists `x`, although package.json on disk does not yet.
 * - pnpm loads the pnpmfile in separate processes for separate hooks, so hooks cannot share state;
 *   the whole check therefore lives in `readPackage`, which reads pnpm-lock.yaml itself.
 * - Throwing from `readPackage` stops the install.
 * A dependency is "new" when no line of the lockfile pairs its name with this specifier. Only the
 * project at the lockfile's root is checked, not other workspace projects.
 * Sources: https://pnpm.io/pnpmfile (readPackage, async support, load location).
 */
export function pnpmfileGuardContent(range: string = `^${PACKAGE_VERSION}`): string {
  return String.raw`// ${PNPMFILE_MARKER}. Before pnpm resolves the project, this checks the
// dependencies that are not yet in pnpm-lock.yaml (what "pnpm add" is adding, or what was edited into
// package.json) with "autoremediator guard", and stops the install if one is blocked.
// What it can and cannot see: ${DOCS_URL}/guides/guard.md
// pnpm hook used: readPackage (https://pnpm.io/pnpmfile). AUTOREMEDIATOR_GUARD=off skips it once.
'use strict';
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const RANGE = ${JSON.stringify(range)};
const MAX_CHECKED = 25;
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const LOCAL = /^(?:workspace|link|file|portal|catalog):/;
const SAFE_NAME = /^(?:@[a-z0-9~._-]+\/)?[a-z0-9~._-]+$/;
const SAFE_RANGE = /^[\w.^~*+-]+$/;

let checked = false;

function read(file) {
  try {
    return readFileSync(join(__dirname, file), 'utf8');
  } catch {
    return undefined;
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

// True when the lockfile already pairs this dependency name with this specifier
// (lockfile v9: "name:" then "specifier: x"; older formats: "name: x").
function inLockfile(lockfile, name, specifier) {
  const line = new RegExp(
    '^[ \\t]+[\'"]?' + escapeRegExp(name) + '[\'"]?:(?:[ \\t]*\\n[ \\t]+specifier:)?[ \\t]*[\'"]?' + escapeRegExp(specifier) + '[\'"]?[ \\t]*$',
    'm',
  );
  return line.test(lockfile);
}

function isRootProject(pkg) {
  try {
    const root = JSON.parse(read('package.json'));
    return pkg.name === root.name && pkg.version === root.version;
  } catch {
    return false;
  }
}

function guardArgument(name, specifier) {
  if (!SAFE_NAME.test(name)) return undefined;
  if (specifier.startsWith('npm:') || !SAFE_RANGE.test(specifier)) return name;
  return name + '@' + specifier;
}

function check(pkg, context) {
  const lockfile = read('pnpm-lock.yaml');
  if (lockfile === undefined) {
    context.log('autoremediator guard: no pnpm-lock.yaml to compare with, so nothing was checked. Run: npx autoremediator guard --git-diff');
    return;
  }
  const added = new Set();
  for (const field of FIELDS) {
    for (const [name, specifier] of Object.entries(pkg[field] || {})) {
      if (typeof specifier !== 'string' || LOCAL.test(specifier) || inLockfile(lockfile, name, specifier)) continue;
      const argument = guardArgument(name, specifier);
      if (argument) added.add(argument);
    }
  }
  const specs = [...added].slice(0, MAX_CHECKED);
  if (specs.length === 0) return;

  const bin = process.env.AUTOREMEDIATOR_BIN;
  const args = (bin ? [] : ['-y', '-p', 'autoremediator@' + RANGE, 'autoremediator']).concat(['guard', ...specs, '--output-format', 'json']);
  const run = spawnSync(bin || 'npx', args, { cwd: __dirname, encoding: 'utf8', timeout: 120000, shell: process.platform === 'win32' });
  if (run.status !== 0 && run.status !== 3 && run.status !== 4) {
    context.log('autoremediator guard could not run (' + (run.error ? run.error.message : 'exit ' + run.status) + '), so ' + specs.length + ' new dependencies were not checked.');
    return;
  }
  let reports;
  try {
    const parsed = JSON.parse(run.stdout);
    reports = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    context.log('autoremediator guard answered something unreadable, so new dependencies were not checked.');
    return;
  }
  const lines = (verdict) =>
    reports
      .filter((report) => report.verdict === verdict)
      .map((report) => report.spec + ': ' + report.findings.filter((finding) => finding.severity !== 'info').map((finding) => finding.message).join(' '));
  for (const line of lines('warn')) context.log('autoremediator guard: check ' + line);
  const blocked = lines('block');
  if (blocked.length > 0) {
    throw new Error('autoremediator guard blocked this install:\n  ' + blocked.join('\n  ') + '\nSet AUTOREMEDIATOR_GUARD=off to install anyway.');
  }
}

module.exports = {
  hooks: {
    readPackage(pkg, context) {
      if (checked || process.env.AUTOREMEDIATOR_GUARD === 'off' || !isRootProject(pkg)) return pkg;
      checked = true;
      check(pkg, context);
      return pkg;
    },
  },
};
`;
}
