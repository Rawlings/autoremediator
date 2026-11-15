import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Values that must never reach any output: they sit in env files, CI files, Dockerfiles and .npmrc. */
export const SECRET_VALUES = [
  "envexamplevalue111",
  "realdotenvvalue222",
  "dockerargvalue333",
  "literalnpmtoken444",
  "hardcodedvalue123",
  "workflowenvvalue555",
];

export interface TestRepo {
  dir: string;
  git(...args: string[]): string;
  write(path: string, content: string): void;
  /** Commit everything, with a fixed author and the given date. Returns the commit sha. */
  commit(message: string, isoDate: string): string;
  cleanup(): void;
}

export function makeRepo(prefix: string): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@example.test",
        "-c",
        "user.name=t",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: dir,
        encoding: "utf8",
      },
    ).trim();
  git("init", "-q", "-b", "main", ".");
  return {
    dir,
    git,
    write(path, content) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content, "utf8");
    },
    commit(message, isoDate) {
      git("add", "-A");
      execFileSync(
        "git",
        [
          "-c",
          "user.email=t@example.test",
          "-c",
          "user.name=t",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-q",
          "-m",
          message,
        ],
        {
          cwd: dir,
          env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
        },
      );
      return git("rev-parse", "HEAD");
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * An npm lockfile (v3) for `app -> mid -> evil-lib`. `evil` is the locked version of evil-lib
 * (absent: not locked at all).
 */
export function npmLock(evil: string | undefined, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    {
      name: "app",
      lockfileVersion: 3,
      packages: {
        "": { name: "app", dependencies: { mid: "^1.0.0" } },
        "node_modules/mid": {
          version: "1.0.0",
          dependencies: evil ? { "evil-lib": "^1.0.0" } : {},
        },
        ...(evil ? { "node_modules/evil-lib": { version: evil, hasInstallScript: true } } : {}),
        ...extra,
      },
    },
    null,
    2,
  )}\n`;
}

export const PACKAGE_JSON = `${JSON.stringify({ name: "app", version: "1.0.0", dependencies: { mid: "^1.0.0" } }, null, 2)}\n`;

export const WORKFLOW = `name: ci
on: [push]
env:
  GLOBAL_TOKEN: \${{ secrets.GLOBAL_SECRET }}
  HARDCODED_TOKEN: workflowenvvalue555
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
        env:
          NPM_TOKEN: \${{ secrets.NPM_PUBLISH_TOKEN }}
      - run: npm test
        env:
          DEPLOY_KEY: \${{ secrets.DEPLOY_KEY }}
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
        env:
          LINT_SECRET: \${{ secrets.ONLY_IN_LINT }}
`;

/** Env, Docker and .npmrc files whose values are secrets. Writes them into the repo. */
export function writeSecretBearingFiles(repo: TestRepo): void {
  repo.write(".github/workflows/ci.yml", WORKFLOW);
  repo.write(".env.example", "API_SECRET=envexamplevalue111\nPLAIN_SETTING=1\n");
  repo.write(".env", "REAL_SECRET=realdotenvvalue222\n");
  repo.write(
    "Dockerfile",
    "FROM node:22\nARG NPM_TOKEN=dockerargvalue333\nRUN --mount=type=secret,id=npmrc npm ci\n",
  );
  repo.write(".npmrc", "//registry.npmjs.org/:_authToken=literalnpmtoken444\n");
}

/**
 * History used by the incident tests. Bad versions are `>=1.0.2`.
 *   c1 evil-lib 1.0.0 (tag v1.0.0), c2 1.0.1 (tag v1.1.0), c3 1.0.2 (branch release), c4 1.0.3 (tag v1.2.0, HEAD)
 */
export function buildHistory(repo: TestRepo): { shas: string[] } {
  repo.write("package.json", PACKAGE_JSON);
  repo.write("package-lock.json", npmLock("1.0.0"));
  writeSecretBearingFiles(repo);
  const c1 = repo.commit("add dependencies", "2026-01-01T10:00:00Z");
  repo.git("tag", "v1.0.0");
  repo.write("package-lock.json", npmLock("1.0.1"));
  const c2 = repo.commit("update lockfile", "2026-02-01T10:00:00Z");
  repo.git("tag", "v1.1.0");
  repo.write("package-lock.json", npmLock("1.0.2"));
  const c3 = repo.commit("update lockfile again", "2026-03-01T10:00:00Z");
  repo.git("branch", "release");
  repo.write("package-lock.json", npmLock("1.0.3"));
  const c4 = repo.commit("and again", "2026-03-05T10:00:00Z");
  repo.git("tag", "v1.2.0");
  return { shas: [c1, c2, c3, c4] };
}
