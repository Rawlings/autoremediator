import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const created: string[] = [];

/** Write a project into a fresh temp directory. Objects become JSON; strings are written as given. */
export function makeProject(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), "diet-"));
  created.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  }
  return dir;
}

/** What `npm install` leaves for a dependency: only its package.json, which is all the analysis reads. */
export function installed(dir: string, packages: Record<string, object | true>): void {
  for (const [name, manifest] of Object.entries(packages)) {
    const target = join(dir, "node_modules", name, "package.json");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify(
        manifest === true ? { name, version: "1.0.0" } : { name, version: "1.0.0", ...manifest },
      ),
    );
  }
}

export function removeProjects(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
