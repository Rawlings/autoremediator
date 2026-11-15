import type { PatchRequest } from "./patch-generator.js";

export const PATCH_SYSTEM_PROMPT = [
  "You are a security engineer fixing a known vulnerability in the published source of an npm package.",
  "Make the smallest change that removes the vulnerability and otherwise preserves behavior.",
  "Return the complete new contents of each file that must change, using exactly the paths provided.",
  "Do not return files that do not need to change.",
].join(" ");

export function buildPatchPrompt(request: PatchRequest): string {
  const files = Object.entries(request.sourceFiles)
    .map(([path, content]) => `<file path="${path}">\n${content}\n</file>`)
    .join("\n");

  return [
    `Vulnerability: ${request.cveId}`,
    `Package: ${request.packageName}@${request.vulnerableVersion}`,
    "",
    "Summary:",
    request.cveSummary,
    "",
    "Package source:",
    files,
  ].join("\n");
}
