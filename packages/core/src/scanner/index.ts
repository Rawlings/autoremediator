export type { NormalizedFinding } from "./adapters/npm-audit.js";
export type ScanInputFormat = "npm-audit" | "yarn-audit" | "sarif" | "auto";
export { parseScanInput, parseScanInputFromAudit } from "./parse-input.js";
export { uniqueCveIds } from "./unique-cve-ids.js";
