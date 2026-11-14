import { PACKAGE_VERSION } from "../../version.js";
import type { HookName } from "./types.js";

export const BLOCK_BEGIN = "# autoremediator:begin";
export const BLOCK_END = "# autoremediator:end";

/** Files whose change makes a push or a merge worth checking. */
const DEPENDENCY_FILES = String.raw`(^|/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?)$`;

/** `^major.minor.0` of this release: new patch releases do not make installed hooks look stale. */
export function hookVersionRange(version: string = PACKAGE_VERSION): string {
  const [major = "0", minor = "0"] = version.split(".");
  return `^${major}.${minor}.0`;
}

/** Quote a value for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

export interface HookScriptOptions {
  /** Project folder relative to the repository root (default `.`). */
  projectDir?: string;
  /** Version range used when the CLI is not installed locally. */
  versionRange?: string;
}

/**
 * Runs a command with a time limit. Uses `timeout` when it exists, else a watchdog; a run that is
 * stopped ends with 124, 137 or 143. Written for `sh -e` too: no unguarded command can fail.
 */
const EXEC_FUNCTION = `autoremediator_exec() {
  ar_t="$1"
  shift
  ar_rc=0
  if command -v timeout >/dev/null 2>&1; then
    timeout "$ar_t" "$@" || ar_rc=$?
    return "$ar_rc"
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$ar_t" "$@" || ar_rc=$?
    return "$ar_rc"
  fi
  "$@" &
  ar_pid=$!
  ( sleep "$ar_t"; kill "$ar_pid" ) >/dev/null 2>&1 &
  ar_watch=$!
  wait "$ar_pid" || ar_rc=$?
  kill "$ar_watch" >/dev/null 2>&1 || true
  return "$ar_rc"
}`;

/** Lines that choose how to run the CLI: local install, global install, or a pinned npx download. */
function resolveCli(versionRange: string): string {
  return `  if [ -x "$ar_dir/node_modules/.bin/autoremediator" ] && command -v npx >/dev/null 2>&1; then
    set -- npx --no-install autoremediator
  elif command -v autoremediator >/dev/null 2>&1; then
    set -- autoremediator
  elif command -v npx >/dev/null 2>&1; then
    set -- npx -y "autoremediator@${versionRange}"
  else
    echo "autoremediator: skipped, the CLI is not available" >&2
    return 0
  fi`;
}

/** Exit early (success) when the changed-file list has no manifest or lockfile in it. */
function changedCheck(from: string, to: string): string {
  return `  if ! git diff --name-only "${from}" "${to}" 2>/dev/null | grep -E '${DEPENDENCY_FILES}' >/dev/null 2>&1; then
    return 0
  fi`;
}

const PRE_PUSH = (dir: string, range: string): string => `autoremediator_pre_push() {
  [ "\${AUTOREMEDIATOR_SKIP_HOOKS:-}" = "1" ] && return 0
  ar_limit="\${AUTOREMEDIATOR_HOOK_TIMEOUT:-60}"
  ar_dir=${shellQuote(dir)}
  ar_base="\${PRE_COMMIT_FROM_REF:-}"
  case "$ar_base" in *[!0]*) ;; *) ar_base="" ;; esac
  if [ -z "$ar_base" ]; then
    ar_base="$(git rev-parse --verify -q "@{upstream}" 2>/dev/null || true)"
  fi
  for ar_ref in refs/remotes/origin/HEAD origin/main origin/master; do
    [ -n "$ar_base" ] && break
    ar_base="$(git rev-parse --verify -q "$ar_ref^{commit}" 2>/dev/null || true)"
  done
  if [ -z "$ar_base" ]; then
    echo "autoremediator: no upstream to compare with, skipping the dependency check" >&2
    return 0
  fi
  if ! git rev-parse --verify -q "$ar_base^{commit}" >/dev/null 2>&1; then
    echo "autoremediator: $ar_base is not known locally, skipping the dependency check" >&2
    return 0
  fi
  ar_head="\${PRE_COMMIT_TO_REF:-HEAD}"
${changedCheck("$ar_base", "$ar_head")}
${resolveCli(range)}
  ar_out="$(mktemp "\${TMPDIR:-/tmp}/autoremediator-hook.XXXXXX" 2>/dev/null)" || ar_out="\${TMPDIR:-/tmp}/autoremediator-hook.$$"
  ar_rc=0
  ( cd "$ar_dir" && autoremediator_exec "$ar_limit" "$@" diff --ci --base "$ar_base" ) >"$ar_out" 2>&1 || ar_rc=$?
  case "$ar_rc" in
    0)
      sed -n 's/^Summary: /autoremediator: /p' "$ar_out" | head -n 1 >&2
      ;;
    124|137|143)
      echo "autoremediator: dependency check stopped after $ar_limit seconds, not blocking the push" >&2
      ;;
    1)
      if grep "Net Risk Verdict: DEGRADED" "$ar_out" >/dev/null 2>&1; then
        cat "$ar_out" >&2
        echo "autoremediator: push blocked, the dependency changes make the project less safe." >&2
        echo "autoremediator: review with 'autoremediator diff --base $ar_base', or set AUTOREMEDIATOR_SKIP_HOOKS=1 to push anyway." >&2
        rm -f "$ar_out"
        return 1
      fi
      echo "autoremediator: dependency check could not finish, not blocking the push" >&2
      head -n 3 "$ar_out" >&2
      ;;
    *)
      echo "autoremediator: dependency check could not finish (exit $ar_rc), not blocking the push" >&2
      ;;
  esac
  rm -f "$ar_out"
  return 0
}
autoremediator_pre_push "$@" || exit $?`;

const POST_MERGE = (dir: string, range: string): string => `autoremediator_post_merge() {
  [ "\${AUTOREMEDIATOR_SKIP_HOOKS:-}" = "1" ] && return 0
  ar_limit="\${AUTOREMEDIATOR_HOOK_TIMEOUT:-30}"
  ar_dir=${shellQuote(dir)}
  git rev-parse --verify -q ORIG_HEAD >/dev/null 2>&1 || return 0
${changedCheck("ORIG_HEAD", "HEAD")}
${resolveCli(range)}
  ar_out="$(mktemp "\${TMPDIR:-/tmp}/autoremediator-hook.XXXXXX" 2>/dev/null)" || ar_out="\${TMPDIR:-/tmp}/autoremediator-hook.$$"
  ar_rc=0
  ( cd "$ar_dir" && autoremediator_exec "$ar_limit" "$@" diff --base ORIG_HEAD ) >"$ar_out" 2>&1 || ar_rc=$?
  ar_summary=""
  if [ "$ar_rc" -eq 0 ]; then
    ar_summary="$(sed -n 's/^Summary: //p' "$ar_out" | head -n 1)"
  fi
  if [ -n "$ar_summary" ]; then
    echo "autoremediator: dependencies changed in this merge. $ar_summary" >&2
  else
    echo "autoremediator: dependencies changed in this merge; run 'autoremediator diff --base ORIG_HEAD' to review" >&2
  fi
  rm -f "$ar_out"
  return 0
}
autoremediator_post_merge "$@" || true`;

/**
 * The marked block for one hook: POSIX sh, safe under `sh -e`, self-contained so it can be pasted
 * into a hook file or into a hook manager's configuration. It always skips (exit 0) when
 * `AUTOREMEDIATOR_SKIP_HOOKS=1` or the CLI cannot run, and never runs longer than the time limit.
 */
export function hookBlock(hook: HookName, options: HookScriptOptions = {}): string {
  const dir = options.projectDir && options.projectDir !== "" ? options.projectDir : ".";
  const range = options.versionRange ?? hookVersionRange();
  const body = hook === "pre-push" ? PRE_PUSH(dir, range) : POST_MERGE(dir, range);
  return [
    BLOCK_BEGIN,
    '# Managed by "autoremediator hook install"; remove it with "autoremediator hook uninstall".',
    "# AUTOREMEDIATOR_SKIP_HOOKS=1 skips it; AUTOREMEDIATOR_HOOK_TIMEOUT sets the time limit in seconds.",
    EXEC_FUNCTION,
    body,
    BLOCK_END,
  ].join("\n");
}
