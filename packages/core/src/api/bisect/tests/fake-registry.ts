import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { execa } from "execa";

/** One published version: its files (path relative to the package root) and dependencies. */
export interface FakePackageVersion {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  /** Extra files; `index.js` defaults to an empty module. */
  files?: Record<string, string>;
}

interface Stored {
  manifest: Record<string, unknown>;
  tarball: Buffer;
  shasum: string;
  integrity: string;
}

/**
 * A tiny npm registry for tests: packuments and tarballs over HTTP on 127.0.0.1, no network. Versions
 * can be published while it runs, so a test can make a lockfile at one point in time and "release" a
 * bad version later, the way a real registry would.
 */
export class FakeRegistry {
  private readonly packages = new Map<string, Map<string, Stored>>();
  private server: Server | undefined;
  private workDir = "";
  url = "";

  async start(): Promise<void> {
    this.workDir = mkdtempSync(join(tmpdir(), "fake-registry-"));
    this.server = createServer((request, response) => {
      const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      const tarball = /^\/(.+)\/-\/([^/]+)-(\d+\.\d+\.\d+[^/]*)\.tgz$/.exec(path);
      if (tarball) {
        const stored = this.packages.get(tarball[1] ?? "")?.get(tarball[3] ?? "");
        if (!stored) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/octet-stream" }).end(stored.tarball);
        return;
      }
      const name = path.slice(1);
      const versions = this.packages.get(name);
      if (!versions) {
        response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
        return;
      }
      const sorted = [...versions.keys()].toSorted((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      );
      const body = {
        name,
        "dist-tags": { latest: sorted.at(-1) },
        versions: Object.fromEntries(
          [...versions].map(([version, stored]) => [
            version,
            {
              ...stored.manifest,
              dist: {
                tarball: `${this.url}/${name}/-/${name}-${version}.tgz`,
                shasum: stored.shasum,
                integrity: stored.integrity,
              },
            },
          ]),
        ),
      };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    const server = this.server;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake registry did not bind");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    rmSync(this.workDir, { recursive: true, force: true });
  }

  /** Make a version installable. */
  async publish(pkg: FakePackageVersion): Promise<void> {
    const dir = join(this.workDir, `${pkg.name.replace("/", "__")}-${pkg.version}`);
    const root = join(dir, "package");
    mkdirSync(root, { recursive: true });
    const manifest = {
      name: pkg.name,
      version: pkg.version,
      main: "index.js",
      ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
    };
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest, null, 2));
    const files = { "index.js": "module.exports = {};\n", ...pkg.files };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const archive = join(dir, "package.tgz");
    await execa("tar", ["-czf", archive, "-C", dir, "package"]);
    const tarball = readFileSync(archive);
    const versions = this.packages.get(pkg.name) ?? new Map<string, Stored>();
    versions.set(pkg.version, {
      manifest,
      tarball,
      shasum: createHash("sha1").update(tarball).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    });
    this.packages.set(pkg.name, versions);
  }
}
