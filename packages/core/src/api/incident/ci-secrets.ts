import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import YAML from "yaml";

/**
 * Which secrets could have been in reach of an `npm install` that ran while a bad package version
 * was locked? This reads CI workflows, Dockerfiles, env templates, `.npmrc` and `package.json`
 * and collects the NAMES of secrets and credential variables they reference.
 *
 * It never reads a value: env templates and `.npmrc` are read line by line and only the name part
 * is kept; real `.env` files are not opened at all; a literal value written into a workflow or a
 * Dockerfile is dropped on the spot. What it returns is a checklist to review, not a finding that
 * anything was exposed.
 */

export type CiProvider =
  | "github-actions"
  | "gitlab-ci"
  | "circleci"
  | "azure-pipelines"
  | "bitbucket-pipelines"
  | "travis"
  | "jenkins";

export interface CiFile {
  /** Relative to the project directory. */
  file: string;
  provider: CiProvider;
  /** Something in the file runs a package install, or runs registry packages (npx, dlx). */
  installs: boolean;
  /** Jobs that install (GitHub Actions only; other providers are read as one unit). */
  installJobs: string[];
  /** Secret names in reach of an install step, its job or the whole workflow. */
  secretNames: string[];
  /** Sensitive-looking environment variable names set or used there. */
  envNames: string[];
  /** Short observations a reviewer should see (OIDC, `secrets: inherit`, contexts). */
  notes: string[];
}

export interface ContainerFile {
  file: string;
  installs: boolean;
  /** `ARG`/`ENV` names that look sensitive, and ids of `--mount=type=secret`. */
  names: string[];
  secretMounts: string[];
}

export interface EnvTemplate {
  file: string;
  names: string[];
  /** The subset that looks like a credential. */
  sensitiveNames: string[];
}

export interface NpmrcFile {
  file: string;
  /** Names inside `${...}` references (typically the token variable). */
  envNames: string[];
  /** A token or password is written into the file itself (its value is never read out). */
  literalCredential: boolean;
}

export interface LifecycleScripts {
  file: string;
  /** Names of install-time scripts the project itself defines. */
  scripts: string[];
}

export interface ChecklistItem {
  id: string;
  text: string;
}

export interface SecretsChecklist {
  /** What this section is, in a sentence: it is read first. */
  disclaimer: string;
  ci: CiFile[];
  containers: ContainerFile[];
  envTemplates: EnvTemplate[];
  npmrc: NpmrcFile[];
  lifecycle: LifecycleScripts[];
  /** Every secret or credential name found, sorted, with where it was found. */
  secretNames: Array<{ name: string; files: string[]; inInstallScope: boolean }>;
  guidance: ChecklistItem[];
  notes: string[];
}

export const CHECKLIST_DISCLAIMER =
  "A checklist to review, not a finding that anything was compromised. It lists the names of secrets that the project's own CI, container and environment files put in reach of a package install, so you can decide what to rotate. Secret values were never read.";

const SENSITIVE =
  /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|PASS\b|CREDENTIAL|AUTH|CERT|PRIVATE|SIGNING|API)/i;
const INSTALL =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i|add|up|update|upgrade|dlx|x|create)\b|\byarn\s*(?:&&|;|$)|\b(?:npx|bunx)\b|\bcorepack\b|\bdocker\s+(?:build|buildx)\b|\bdocker\/build-push-action\b/im;
const LIFECYCLE = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
];
const MAX_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
]);

/** Variables every CI sets itself; they are not credentials. */
const BUILTIN =
  /^(?:PATH|HOME|USER|PWD|SHELL|CI|NODE_ENV|TERM|LANG|LC_ALL|TZ|HOSTNAME|TMPDIR|DEBIAN_FRONTEND|CI_[A-Z0-9_]*|GITHUB_[A-Z0-9_]*|RUNNER_[A-Z0-9_]*|GITLAB_[A-Z0-9_]*|CIRCLE_[A-Z0-9_]*|BITBUCKET_[A-Z0-9_]*|BUILD_[A-Z0-9_]*|SYSTEM_[A-Z0-9_]*|AGENT_[A-Z0-9_]*|TRAVIS_[A-Z0-9_]*|NODE_VERSION|NPM_CONFIG_[A-Z0-9_]*)$/;

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].toSorted();

function readSmallText(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    // Never follow a symlink out of the project, and never slurp something huge.
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Files under `cwd` whose relative path passes `accept`, at most `depth` directories deep. Symlinks are not followed. */
function walk(
  cwd: string,
  accept: (relativePath: string, name: string) => boolean,
  depth = 4,
): string[] {
  const found: string[] = [];
  const visit = (dir: string, level: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.toSorted()) {
      const full = join(dir, name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        // Hidden CI directories matter; other hidden ones and build output do not.
        if (
          level < depth &&
          !SKIP_DIRS.has(name) &&
          (!name.startsWith(".") || name === ".github" || name === ".circleci")
        ) {
          visit(full, level + 1);
        }
      } else if (stat.isFile() && accept(relative(cwd, full), name)) {
        found.push(relative(cwd, full));
      }
      if (found.length >= 400) return;
    }
  };
  visit(cwd, 0);
  return found;
}

function stringsIn(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 30) return out;
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const child of node) stringsIn(child, out, depth + 1);
  else if (typeof node === "object" && node !== null) {
    for (const child of Object.values(node)) stringsIn(child, out, depth + 1);
  }
  return out;
}

function keysIn(node: unknown, key: string, out: string[] = [], depth = 0): string[] {
  if (depth > 30 || typeof node !== "object" || node === null) return out;
  if (Array.isArray(node)) {
    for (const child of node) keysIn(child, key, out, depth + 1);
    return out;
  }
  for (const [name, child] of Object.entries(node)) {
    if (name === key && typeof child === "object" && child !== null && !Array.isArray(child))
      out.push(...Object.keys(child));
    keysIn(child, key, out, depth + 1);
  }
  return out;
}

const SECRET_REF = /secrets\.([A-Za-z_][A-Za-z0-9_-]*)|secrets\[\s*['"]([^'"]+)['"]\s*\]/g;

function secretsIn(node: unknown): string[] {
  const names: string[] = [];
  for (const text of stringsIn(node)) {
    for (const match of text.matchAll(SECRET_REF)) {
      const name = match[1] ?? match[2];
      if (name) names.push(name);
    }
  }
  return names;
}

const sensitiveEnvKeys = (node: unknown): string[] =>
  keysIn(node, "env").filter((name) => SENSITIVE.test(name));

function stepInstalls(step: unknown): boolean {
  if (typeof step !== "object" || step === null) return false;
  const record = step as Record<string, unknown>;
  const run = typeof record["run"] === "string" ? record["run"] : "";
  const uses = typeof record["uses"] === "string" ? record["uses"] : "";
  return INSTALL.test(run) || INSTALL.test(uses);
}

function scanGithubWorkflow(file: string, text: string): CiFile {
  const result: CiFile = {
    file,
    provider: "github-actions",
    installs: false,
    installJobs: [],
    secretNames: [],
    envNames: [],
    notes: [],
  };
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch {
    // Not valid YAML: fall back to reading the text for names, and say so.
    result.installs = INSTALL.test(text);
    result.secretNames = sorted(secretsIn(text));
    result.notes.push(
      "The workflow is not valid YAML, so it was only scanned as text; jobs could not be told apart.",
    );
    return result;
  }
  const workflow = typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>) : {};
  const jobs =
    typeof workflow["jobs"] === "object" && workflow["jobs"] !== null
      ? (workflow["jobs"] as Record<string, unknown>)
      : {};

  const workflowSecrets = secretsIn(workflow["env"]);
  const secrets = new Set<string>();
  const envNames = new Set<string>(sensitiveEnvKeys({ env: workflow["env"] }));

  for (const [jobId, raw] of Object.entries(jobs)) {
    const job = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const steps = Array.isArray(job["steps"]) ? job["steps"] : [];
    const installSteps = steps.filter((step) => stepInstalls(step));
    const reusable = typeof job["uses"] === "string";
    if (installSteps.length === 0 && !reusable) continue;

    result.installJobs.push(jobId);
    result.installs = installSteps.length > 0 || result.installs;
    // Anything the job runs after the install can execute the installed code, so the whole job counts.
    for (const name of [
      ...workflowSecrets,
      ...secretsIn(job["env"]),
      ...secretsIn(steps),
      ...secretsIn(job["with"]),
      ...secretsIn(job["secrets"]),
    ]) {
      secrets.add(name);
    }
    for (const name of [...sensitiveEnvKeys({ env: job["env"] }), ...sensitiveEnvKeys(steps)])
      envNames.add(name);

    if (job["secrets"] === "inherit") {
      result.notes.push(
        `Job "${jobId}" calls a reusable workflow with \`secrets: inherit\`: every secret the caller can see is passed on.`,
      );
    }
    const permissions =
      typeof job["permissions"] === "object" && job["permissions"] !== null
        ? (job["permissions"] as Record<string, unknown>)
        : {};
    const topPermissions =
      typeof workflow["permissions"] === "object" && workflow["permissions"] !== null
        ? (workflow["permissions"] as Record<string, unknown>)
        : {};
    if (permissions["id-token"] === "write" || topPermissions["id-token"] === "write") {
      result.notes.push(
        `Job "${jobId}" can request an OIDC token: short-lived cloud credentials may have been minted in it.`,
      );
    }
    const credentialActions = stringsIn(steps).filter((value) =>
      /^(?:aws-actions\/configure-aws-credentials|google-github-actions\/auth|azure\/login|docker\/login-action|hashicorp\/vault-action)@/.test(
        value,
      ),
    );
    for (const action of sorted(credentialActions)) {
      result.notes.push(
        `Job "${jobId}" uses ${action.split("@")[0]}, which puts cloud or registry credentials in the job's environment.`,
      );
    }
  }
  // Names GitHub provides itself are worth one line, not a row each.
  if (secrets.delete("GITHUB_TOKEN")) {
    result.notes.push(
      "`secrets.GITHUB_TOKEN` (the automatic repository token) is in reach of an install job; its permissions are set by the workflow's `permissions:`.",
    );
  }
  result.secretNames = sorted(secrets);
  result.envNames = sorted(envNames);
  result.notes = sorted(result.notes);
  return result;
}

/** Providers read as one unit: variable names that look like credentials, plus contexts and credential ids. */
function scanGenericCi(file: string, provider: CiProvider, text: string): CiFile {
  const names = new Set<string>();
  for (const match of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    const name = match[1]!;
    if (!BUILTIN.test(name) && SENSITIVE.test(name)) names.add(name);
  }
  for (const match of text.matchAll(/\$\(([A-Za-z_][A-Za-z0-9_.]*)\)/g)) {
    const name = match[1]!;
    if (!BUILTIN.test(name) && SENSITIVE.test(name)) names.add(name);
  }
  const notes: string[] = [];
  for (const match of text.matchAll(
    /credentials\(\s*['"]([^'"]+)['"]\s*\)|credentialsId\s*:\s*['"]([^'"]+)['"]/g,
  )) {
    const id = match[1] ?? match[2];
    if (id) names.add(id);
  }
  const contexts = [
    ...text.matchAll(/^\s*-?\s*context\s*:\s*\[?\s*([A-Za-z0-9_.\- ,]+?)\s*\]?\s*$/gm),
  ].flatMap((match) => (match[1] ?? "").split(",").map((entry) => entry.trim()));
  for (const context of sorted(contexts.filter((entry) => entry !== ""))) {
    notes.push(
      `Uses the CircleCI context "${context}": every variable stored in that context is in reach of the job.`,
    );
  }
  if (
    provider === "gitlab-ci" ||
    provider === "azure-pipelines" ||
    provider === "bitbucket-pipelines" ||
    provider === "travis"
  ) {
    notes.push(
      "Variables are read from the file by name only; whether each one holds a secret depends on the CI project's settings, which are not in the repository.",
    );
  }
  return {
    file,
    provider,
    installs: INSTALL.test(text),
    installJobs: [],
    secretNames: sorted(names),
    envNames: [],
    notes,
  };
}

const CI_FILES: Array<{ test: (path: string) => boolean; provider: CiProvider }> = [
  { test: (path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path), provider: "github-actions" },
  { test: (path) => path === ".gitlab-ci.yml", provider: "gitlab-ci" },
  { test: (path) => path === ".circleci/config.yml", provider: "circleci" },
  {
    test: (path) => path === "azure-pipelines.yml" || path === ".azure-pipelines.yml",
    provider: "azure-pipelines",
  },
  { test: (path) => path === "bitbucket-pipelines.yml", provider: "bitbucket-pipelines" },
  { test: (path) => path === ".travis.yml", provider: "travis" },
  { test: (path) => path === "Jenkinsfile", provider: "jenkins" },
];

function scanDockerfile(file: string, text: string): ContainerFile {
  const names = new Set<string>();
  const mounts = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const directive = /^\s*(ARG|ENV)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(line);
    // Only the name after the keyword is kept; whatever follows the `=` is a value and is dropped here.
    if (directive?.[2] && SENSITIVE.test(directive[2])) names.add(directive[2]);
    for (const match of line.matchAll(
      /(?:--mount=type=secret,[^\s]*?id=|--secret(?:\s+|=)(?:[^\s,]*,)*?id=)([A-Za-z0-9_.-]+)/g,
    )) {
      mounts.add(match[1]!);
    }
  }
  return { file, installs: INSTALL.test(text), names: sorted(names), secretMounts: sorted(mounts) };
}

function scanEnvTemplate(file: string, text: string): EnvTemplate {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  const all = sorted(names);
  return { file, names: all, sensitiveNames: all.filter((name) => SENSITIVE.test(name)) };
}

function scanNpmrc(file: string, text: string): NpmrcFile {
  const envNames = new Set<string>();
  let literalCredential = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(line)) continue;
    const credential = /(_authToken|_auth|_password|:_authToken)\s*=\s*(.*)$/i.exec(line);
    if (!credential) continue;
    const refs = [...(credential[2] ?? "").matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
      (match) => match[1]!,
    );
    for (const name of refs) envNames.add(name);
    // A value that is not a `${VAR}` reference is a credential written into the file; note that, not what it is.
    if (refs.length === 0 && (credential[2] ?? "").trim() !== "") literalCredential = true;
  }
  return { file, envNames: sorted(envNames), literalCredential };
}

const GENERIC_GUIDANCE: ChecklistItem[] = [
  {
    id: "npm-tokens",
    text: "Rotate npm tokens that could publish or read private packages: automation and publish tokens in npmjs.com account settings, the NPM_TOKEN-style secrets named above, and any token in a developer's ~/.npmrc.",
  },
  {
    id: "ci-secrets",
    text: "Rotate the CI secrets listed above for every workflow that installs dependencies, starting with deploy keys, cloud credentials and registry tokens. Check the CI provider's audit log for use of them outside normal runs.",
  },
  {
    id: "cloud-keys",
    text: "Rotate cloud access keys and revoke long-lived sessions (AWS access keys and STS sessions, GCP service account keys, Azure service principal secrets) that a build or a developer machine could reach. Prefer short-lived OIDC credentials afterwards.",
  },
  {
    id: "git-and-ssh",
    text: "Rotate GitHub or GitLab personal access tokens, deploy keys and SSH keys that lived on affected CI runners or developer machines, and review recent pushes, releases and workflow changes for anything you did not make.",
  },
  {
    id: "developer-machines",
    text: "Anyone who ran an install on an affected commit locally had their environment in reach too: .env files, shell history and exported variables, ~/.aws, ~/.ssh, browser-stored tokens. Ask them to check and rotate.",
  },
  {
    id: "rebuild",
    text: "Delete caches and rebuild from a clean checkout once the lockfile is back on a safe version (restore the CI cache, rebuild images, republish anything built while the bad version was present).",
  },
  {
    id: "verify",
    text: "After rotating, confirm the old credentials no longer work, and keep the incident report with the dates of the exposure window for the post-mortem.",
  },
];

/** Collect the names of secrets reachable from package installs in the project at `cwd`. */
export function scanSecrets(cwd: string): SecretsChecklist {
  const notes: string[] = [];

  const ci: CiFile[] = [];
  const containers: ContainerFile[] = [];
  const envTemplates: EnvTemplate[] = [];
  const npmrc: NpmrcFile[] = [];

  const files = walk(
    cwd,
    (path, name) =>
      CI_FILES.some((candidate) => candidate.test(path.split("\\").join("/"))) ||
      /^(?:Dockerfile(?:\..+)?|.+\.Dockerfile)$/.test(name) ||
      /^(?:\.env(?:\..+)?\.(?:example|sample|template|dist)|(?:example|sample)\.env|env\.example)$/.test(
        name,
      ) ||
      path === ".npmrc",
  );

  for (const file of files) {
    const posix = file.split("\\").join("/");
    const name = posix.slice(posix.lastIndexOf("/") + 1);
    const text = readSmallText(join(cwd, file));
    if (text === undefined) {
      notes.push(`${posix} was not read (a symlink, unreadable, or larger than 1 MB).`);
      continue;
    }
    const provider = CI_FILES.find((candidate) => candidate.test(posix))?.provider;
    if (provider === "github-actions") ci.push(scanGithubWorkflow(posix, text));
    else if (provider) ci.push(scanGenericCi(posix, provider, text));
    else if (/Dockerfile/.test(name)) containers.push(scanDockerfile(posix, text));
    else if (posix === ".npmrc") npmrc.push(scanNpmrc(posix, text));
    else envTemplates.push(scanEnvTemplate(posix, text));
  }

  const lifecycle: LifecycleScripts[] = [];
  const manifest = readSmallText(join(cwd, "package.json"));
  if (manifest !== undefined) {
    try {
      const scripts = (JSON.parse(manifest) as { scripts?: Record<string, unknown> }).scripts ?? {};
      const own = LIFECYCLE.filter((name) => typeof scripts[name] === "string");
      if (own.length > 0) lifecycle.push({ file: "package.json", scripts: own });
    } catch {
      notes.push("package.json is not valid JSON, so its install-time scripts were not listed.");
    }
  }
  if (files.length === 0 && lifecycle.length === 0) {
    notes.push(
      "No CI workflow, Dockerfile, env template or .npmrc was found, so no secret names are listed. The generic guidance still applies to developer machines.",
    );
  }
  notes.push(
    "Real .env files are never opened; only templates (.env.example and similar) are read, and only for variable names.",
  );

  const byName = new Map<string, { files: Set<string>; inInstallScope: boolean }>();
  const note = (name: string, file: string, install: boolean): void => {
    const entry = byName.get(name) ?? { files: new Set<string>(), inInstallScope: false };
    entry.files.add(file);
    entry.inInstallScope ||= install;
    byName.set(name, entry);
  };
  for (const entry of ci) {
    for (const name of [...entry.secretNames, ...entry.envNames])
      note(name, entry.file, entry.installs || entry.installJobs.length > 0);
  }
  for (const entry of containers) {
    for (const name of [...entry.names, ...entry.secretMounts])
      note(name, entry.file, entry.installs);
  }
  for (const entry of npmrc) for (const name of entry.envNames) note(name, entry.file, true);
  // Templates describe what a developer's environment holds, which a local install can reach.
  for (const entry of envTemplates)
    for (const name of entry.sensitiveNames) note(name, entry.file, true);

  return {
    disclaimer: CHECKLIST_DISCLAIMER,
    ci: ci.toSorted((a, b) => a.file.localeCompare(b.file)),
    containers,
    envTemplates,
    npmrc,
    lifecycle,
    secretNames: [...byName.entries()]
      .map(([name, entry]) => ({
        name,
        files: sorted(entry.files),
        inInstallScope: entry.inInstallScope,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    guidance: GENERIC_GUIDANCE,
    notes,
  };
}
