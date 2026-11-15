import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { realOrResolve } from "../../shared/path-guard.js";
import { classifyPath } from "../verify/changes.js";

export class ScopeViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeViolation";
  }
}

/** Files that hold credentials: an agent has no reason to read them, and its context goes to a provider. */
const SECRET_NAMES =
  /^(\.env(\..*)?|\.envrc|\.npmrc|\.yarnrc(\.yml)?|\.netrc|_netrc|\.git-credentials|\.pypirc|\.dev\.vars|credentials(\..*)?|.*serviceaccount.*\.json|.*\.tfvars|id_rsa.*|id_ed25519.*|.*\.(pem|key|p12|pfx))$/i;

/** A test file the agent would be creating: it could hold anything, and `runCheck` runs it. */
const TEST_FILE = /(?:\.|\/)(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\//i;

/**
 * What an agent working in a checkout may read and write. Everything is confined to the checkout
 * after resolving symlinks; reads exclude credentials and git internals; writes are limited to the
 * project's own source files, never manifests, lockfiles, CI workflows or the policy.
 */
export class ScopeGuard {
  readonly root: string;

  constructor(root: string) {
    this.root = existsSync(root) ? realpathSync(root) : resolve(root);
  }

  /** Absolute, symlink-resolved path inside the checkout, or a violation. */
  resolveInside(path: string): string {
    const full = realOrResolve(isAbsolute(path) ? path : resolve(this.root, path));
    const rel = relative(this.root, full);
    if (rel === "") return full;
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new ScopeViolation(`"${path}" is outside the project checkout`);
    }
    return full;
  }

  relativePath(full: string): string {
    return relative(this.root, full).split(sep).join("/");
  }

  assertReadable(path: string): string {
    const full = this.resolveInside(path);
    const rel = this.relativePath(full);
    const name = basename(full);
    if (rel === ".git" || rel.startsWith(".git/") || rel.startsWith(".autoremediator/")) {
      throw new ScopeViolation(`"${rel}" is not readable`);
    }
    if (SECRET_NAMES.test(name))
      throw new ScopeViolation(`"${rel}" may hold credentials and is not readable`);
    return full;
  }

  assertWritable(path: string): string {
    const full = this.resolveInside(path);
    const rel = this.relativePath(full);
    if (rel === "") throw new ScopeViolation("cannot write to the project root itself");
    const kind = classifyPath(rel);
    if (kind === "forbidden") throw new ScopeViolation(`"${rel}" is never changed by remediation`);
    if (kind === "tooling") {
      throw new ScopeViolation(`"${rel}" is build or test configuration, which runs code`);
    }
    if (kind === "source" && !existsSync(full) && TEST_FILE.test(rel)) {
      throw new ScopeViolation(
        `"${rel}" would be a new test file: only existing tests may be edited, because tests run with the project's privileges`,
      );
    }
    if (kind !== "source") {
      throw new ScopeViolation(
        `"${rel}" is not project source: only JavaScript and TypeScript files may be edited (dependency files change through the upgrade itself)`,
      );
    }
    return full;
  }
}
