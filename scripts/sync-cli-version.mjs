// Keeps the VS Code extension's pinned CLI version equal to the core package's after
// `changeset version`. The extension runs this exact release when a project has no copy of its own.
import { readFileSync, writeFileSync } from "node:fs";

const core = JSON.parse(readFileSync("packages/core/package.json", "utf8")).version;
const file = "packages/vscode-extension/src/cli-version.ts";
const source = readFileSync(file, "utf8");
const next = source.replace(/CLI_VERSION = "[^"]*"/, `CLI_VERSION = "${core}"`);
if (next !== source) writeFileSync(file, next);
